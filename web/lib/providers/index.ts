import { vastProvider } from './vast'
import { runpodProvider } from './runpod'
import { hetznerProvider } from './hetzner'
import type { GpuProvider, VpsProvider } from './types'

// Provider registry + resolver. Lives here (not in any single provider file) so
// the broker, reaper, and teardown depend on a provider-neutral module.
//
// SRT ingest (UDP) is the ONLY OBS→pod transport, so a GPU provider is eligible
// only if its hosts forward UDP. Vast.ai is the sole GPU provider today. RunPod
// was removed: its pods are TCP-only (no UDP/SRT). Under the VPS-hub topology the
// GPU receives a TCP bridge from the VPS (not OBS's UDP), which lifts that cage —
// but that's a SLIMCAST_VPS_HUB-gated future path; the direct GPU registry below
// stays Vast-only until then.
export const ACTIVE_PROVIDERS: GpuProvider[] = [vastProvider]

// VPS-hub GPU BACKEND catalog (the "no Vast-only" mandate). Used ONLY by the bridge
// race (mode:'backend'), which receives an mpegts-over-TCP bridge — so TCP-only RunPod
// is viable here (it was banned only by SRT/UDP ingest). Kept SEPARATE from
// ACTIVE_PROVIDERS so the legacy all-in-one path (SRT ingest, flag-off rollback) stays
// Vast-only and can't accidentally land on a RunPod box that can't take OBS's UDP.
export const ACTIVE_BACKEND_PROVIDERS: GpuProvider[] = [vastProvider, runpodProvider]

const PROVIDERS: Record<string, GpuProvider> = {
  vast: vastProvider,
  runpod: runpodProvider,
}

/** Resolve the GPU provider that owns an existing instance (for stop/teardown).
 *
 * STRICT by design: a NULL/empty provider is a legacy row (predates the provider
 * column — those are all Vast) and resolves to Vast for backward compatibility.
 * But an UNKNOWN non-empty provider name now THROWS instead of silently falling
 * back to Vast. The old `?? 'vast'` catch-all was the #1 leak risk: once a second
 * provider exists (Hetzner), routing e.g. a Hetzner box id to Vast.destroy() is a
 * no-op against the wrong API — the box leaks and bills forever. Fail loud. */
export function getProvider(name: string | null | undefined): GpuProvider {
  if (name == null || name === '') return vastProvider
  const p = PROVIDERS[name]
  if (!p) {
    throw new Error(
      `Unknown GPU provider '${name}' — refusing to route teardown to the wrong API ` +
      `(silent fallback would leak the instance). Register it in providers/index.ts ` +
      `or use getVpsProvider() if it's a VPS hub.`,
    )
  }
  return p
}

// ── VPS hub providers (VPS-as-the-Hub) ───────────────────────────────────────
// Separate registry from the GPU providers above: a VPS hub and a GPU backend are
// different box types with different lifecycles. Hetzner first; Vultr later just
// appends to ACTIVE_VPS_PROVIDERS (zero broker change).
export const ACTIVE_VPS_PROVIDERS: VpsProvider[] = [hetznerProvider]

const VPS_PROVIDERS: Record<string, VpsProvider> = {
  hetzner: hetznerProvider,
}

/** Resolve the VPS provider that owns a relay_nodes(role='vps_hub') box.
 * Strict: throws on unknown — there is no safe default for releasing a billable
 * server + primary IP against the wrong API. */
export function getVpsProvider(name: string | null | undefined): VpsProvider {
  const p = name ? VPS_PROVIDERS[name] : undefined
  if (!p) {
    throw new Error(
      `Unknown VPS provider '${name ?? '(null)'}' — cannot route teardown ` +
      `(would leak the server + its primary IPv4). Register it in providers/index.ts.`,
    )
  }
  return p
}
