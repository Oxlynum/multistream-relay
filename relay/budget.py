"""Live infrastructure-cost measurement (CostMeter) for GPU bridge telemetry.

The GPU box is the only place that knows real-time bandwidth (`/proc/net/dev`).
The broker injects the cost rates at provision (GPU $/hr + per-TB egress/ingress
prices from the provider offer). Combining the two gives the box its true $/hr,
which it reports each heartbeat as telemetry.

On a single-tenant GPU backend the whole external throughput IS the VPS↔GPU
bridge leg, so this doubles as the bridge's ingress/egress measurement.

IMPORTANT: this measures SlimCast's *infrastructure cost*, not the user's bill.
The user is billed by burn_rate (platform count + add-ons) regardless. This is
measure-and-report only — no action is taken on the numbers here.
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
# Defaults are 0 so a box missing them simply reports $0/hr rather than a bogus rate.
GPU_RATE_USD       = _env_float("SLIMCAST_GPU_RATE_USD", 0.0)        # fixed $/hr, independent of bitrate
EGRESS_USD_PER_TB  = _env_float("SLIMCAST_EGRESS_USD_PER_TB", 0.0)   # out to platforms (+ pod→anywhere)
INGRESS_USD_PER_TB = _env_float("SLIMCAST_INGRESS_USD_PER_TB", 0.0)  # OBS → pod

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
    returns None (no rate can be derived from a single sample).
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
