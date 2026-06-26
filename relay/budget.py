"""Live infrastructure-cost measurement + budget-throttle controller.

The pod is the only place that knows real-time bandwidth (`/proc/net/dev`). The
broker injects the cost rates at provision (GPU $/hr + per-TB egress/ingress
prices from the Vast offer). Combining the two gives the pod its true $/hr, which
the controller uses to keep quality just under the ceiling — degrading instead of
killing the stream when bandwidth spikes (e.g. 1440p + YouTube passthrough).

IMPORTANT: this measures SlimCast's *Vast cost*, not the user's bill. The user is
billed by burn_rate (platform count + add-ons) regardless of throttling. This loop
only protects the margin between flat user revenue and variable infrastructure cost.

Phase 1 (this file, initial): CostMeter — measure + report only, no action.
Later phases add the tier controller on top.
"""
from __future__ import annotations

import os
import time


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return default


# Cost rates injected at provision by the provider's create() + the provision route.
# Defaults are 0 / a safe ceiling so a pod missing them simply never throttles
# rather than throttling to the floor on bad data.
GPU_RATE_USD       = _env_float("SLIMCAST_GPU_RATE_USD", 0.0)        # fixed $/hr, independent of bitrate
EGRESS_USD_PER_TB  = _env_float("SLIMCAST_EGRESS_USD_PER_TB", 0.0)   # out to platforms (+ pod→anywhere)
INGRESS_USD_PER_TB = _env_float("SLIMCAST_INGRESS_USD_PER_TB", 0.0)  # OBS → pod
COST_CEILING_USD   = _env_float("SLIMCAST_COST_CEILING_USD", 1.0)    # target $/hr ceiling

_BYTES_PER_TB = 1_000_000_000_000  # Vast bills per decimal TB
_BYTES_PER_GB = 1_000_000_000


def _read_net_counters() -> tuple[int, int]:
    """Sum rx/tx bytes across every real interface (exclude loopback).

    Loopback MUST be excluded: the MediaMTX→FFmpeg SRT loopback (127.0.0.1:8890)
    carries the full HEVC stream once per encoder over `lo`, which has no bandwidth
    cost. Only external-interface bytes hit the Vast bill. Returns (rx_bytes, tx_bytes);
    rx = ingress (OBS→pod), tx = egress (pod→platforms).
    """
    rx_total = 0
    tx_total = 0
    try:
        with open("/proc/net/dev", "r") as f:
            for line in f:
                if ":" not in line:
                    continue
                iface, rest = line.split(":", 1)
                iface = iface.strip()
                if iface == "lo" or not iface:
                    continue
                cols = rest.split()
                if len(cols) < 9:
                    continue
                rx_total += int(cols[0])   # rx_bytes
                tx_total += int(cols[8])   # tx_bytes
    except (OSError, ValueError):
        pass
    return rx_total, tx_total


class CostMeter:
    """Tracks byte counters between heartbeats and derives a live $/hr.

    Call `sample()` once per heartbeat. The first call has no prior delta, so it
    returns None (the controller seeds from estimates until a real delta exists).
    """

    def __init__(self) -> None:
        self._last_rx: int | None = None
        self._last_tx: int | None = None
        self._last_t: float | None = None

    def sample(self) -> dict | None:
        """Return live cost metrics since the previous sample, or None on the
        first call / a zero-length interval.

        Shape: { egress_gb_hr, ingress_gb_hr, projected_usd_hr }.
        """
        rx, tx = _read_net_counters()
        now = time.monotonic()

        prev_rx, prev_tx, prev_t = self._last_rx, self._last_tx, self._last_t
        self._last_rx, self._last_tx, self._last_t = rx, tx, now

        if prev_t is None:
            return None
        dt_s = now - prev_t
        if dt_s <= 0:
            return None

        # Counters can wrap or reset (interface bounce) — clamp negatives to 0.
        d_rx = max(0, rx - (prev_rx or 0))
        d_tx = max(0, tx - (prev_tx or 0))

        dt_hr = dt_s / 3600.0
        ingress_gb_hr = (d_rx / _BYTES_PER_GB) / dt_hr
        egress_gb_hr = (d_tx / _BYTES_PER_GB) / dt_hr

        egress_cost = (d_tx / _BYTES_PER_TB) / dt_hr * EGRESS_USD_PER_TB
        ingress_cost = (d_rx / _BYTES_PER_TB) / dt_hr * INGRESS_USD_PER_TB
        projected = GPU_RATE_USD + egress_cost + ingress_cost

        return {
            "egress_gb_hr": round(egress_gb_hr, 3),
            "ingress_gb_hr": round(ingress_gb_hr, 3),
            "projected_usd_hr": round(projected, 4),
        }


# ── Quality-tier ladder ───────────────────────────────────────────────────────
# One discrete ladder is the single source of truth. The controller moves ONE step
# at a time on measured cost (never juggles knobs independently — that oscillates).
# Each tier is a complete configuration of caps:
#   source_kbps   — OBS encoder bitrate to suggest (cuts ingress + YouTube passthrough)
#   landscape_kbps/portrait_kbps — caps applied as min(user_config, cap) on transcode groups
#   max_height    — resolution ceiling for transcode groups (scale_cuda downscale)
# Tier 0 = full quality; higher index = more throttled. Numbers are seeded from the
# plan's @ $40/TB estimates and refined against real /proc/net/dev measurements.
TIERS: list[dict] = [
    {"source_kbps": 18000, "landscape_kbps": 8000, "portrait_kbps": 4500, "max_height": 1440},
    {"source_kbps": 12000, "landscape_kbps": 8000, "portrait_kbps": 4500, "max_height": 1440},
    {"source_kbps":  9000, "landscape_kbps": 8000, "portrait_kbps": 4500, "max_height": 1080},
    {"source_kbps":  6000, "landscape_kbps": 6000, "portrait_kbps": 4000, "max_height": 1080},
    {"source_kbps":  4500, "landscape_kbps": 4500, "portrait_kbps": 3000, "max_height":  720},
]

# Recover quality only once cost sits below this fraction of the ceiling, and only
# after RECOVER_CALM_BEATS consecutive calm samples — "down fast, up slow". The gap
# between the throttle-down trigger (>ceiling) and the recover trigger (<85%) is a
# dead-band that stops the controller flapping (which would restart FFmpeg every 10s).
RECOVER_HEADROOM = 0.85
RECOVER_CALM_BEATS = 3


def _height_for_resolution(res: str | None) -> int:
    return {"720p": 720, "1080p": 1080, "1440p": 1440}.get(res or "1080p", 1080)


def _floor_tier_for_height(max_height: int) -> int:
    """Best (lowest-index) tier the user is entitled to, given the highest
    resolution any of their outputs is configured for. The controller never
    recovers above this — a 1080p user can't be pushed to the 1440p tiers."""
    for i, t in enumerate(TIERS):
        if t["max_height"] <= max_height:
            return i
    return len(TIERS) - 1


class BudgetController:
    """Picks a quality tier from measured cost, with down-fast/up-slow hysteresis.

    Stateful across heartbeats. `update(projected_usd_hr)` returns the tier spec to
    apply. `set_floor_from_config(cfg)` derives the user's entitlement from their
    configured output resolutions and clamps the tier so we never deliver — or
    bill for — quality above what they asked for, nor recover past it.
    """

    def __init__(self, ceiling_usd: float) -> None:
        self.ceiling = ceiling_usd if ceiling_usd > 0 else 1.0
        self.floor_tier = 0
        self.tier = 0
        self._calm = 0

    def set_floor_from_config(self, cfg: dict) -> None:
        outputs = (cfg or {}).get("outputs", []) or []
        max_h = max((_height_for_resolution(o.get("resolution")) for o in outputs), default=1080)
        self.floor_tier = _floor_tier_for_height(max_h)
        if self.tier < self.floor_tier:
            self.tier = self.floor_tier

    def update(self, projected_usd_hr: float | None) -> dict:
        """Advance the controller one heartbeat. Pass None on the first beat (no
        measurement yet) to simply hold at the current/floor tier."""
        if projected_usd_hr is None:
            self.tier = max(self.tier, self.floor_tier)
            return self.current()

        if projected_usd_hr > self.ceiling:
            # Over budget — throttle down a step immediately (clamp to worst tier).
            self.tier = min(self.tier + 1, len(TIERS) - 1)
            self._calm = 0
        elif projected_usd_hr < self.ceiling * RECOVER_HEADROOM:
            # Comfortably under — recover one step after a few calm beats, but
            # never above the user's entitled floor.
            self._calm += 1
            if self._calm >= RECOVER_CALM_BEATS and self.tier > self.floor_tier:
                self.tier -= 1
                self._calm = 0
        else:
            # Dead-band: between 85% and 100% of ceiling — hold and reset the
            # recovery counter so we don't drift up while near the limit.
            self._calm = 0

        self.tier = max(self.tier, self.floor_tier)
        return self.current()

    def current(self) -> dict:
        return TIERS[self.tier]

    @property
    def throttled(self) -> bool:
        """True when quality is being held below the user's entitled floor."""
        return self.tier > self.floor_tier

    def suggested_ingest_kbps(self) -> int | None:
        """OBS source bitrate to ask the plugin for. None when at the user's floor
        (let their OBS run at its configured bitrate); a cap once throttling."""
        return TIERS[self.tier]["source_kbps"] if self.throttled else None


def throttle_config(cfg: dict, tier: dict) -> dict:
    """Return a copy of the agent config with each transcode output's bitrate and
    resolution capped to the tier. Passthrough outputs (YouTube HEVC copy) are left
    untouched — their bitrate follows the OBS source, throttled via the plugin, not
    here. Caps are applied as min(), so a tier never raises a user's chosen bitrate.
    """
    max_label = {720: "720p", 1080: "1080p", 1440: "1440p"}.get(tier["max_height"], "1080p")
    out_cfg = dict(cfg)
    new_outputs = []
    for o in (cfg.get("outputs", []) or []):
        o2 = dict(o)
        if o2.get("mode") == "passthrough":
            new_outputs.append(o2)
            continue
        cap = tier["portrait_kbps"] if o2.get("orientation") == "portrait" else tier["landscape_kbps"]
        if o2.get("bitrate_kbps"):
            o2["bitrate_kbps"] = min(int(o2["bitrate_kbps"]), cap)
        else:
            o2["bitrate_kbps"] = cap
        # Cap resolution: only ever lower it.
        if _height_for_resolution(o2.get("resolution")) > tier["max_height"]:
            o2["resolution"] = max_label
        new_outputs.append(o2)
    out_cfg["outputs"] = new_outputs
    return out_cfg
