import { vastProvider } from './vast'
import { runpodProvider } from './runpod'
import { hetznerProvider } from './hetzner'
import type { GpuProvider, VpsProvider } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// ONE provider registry (termination-system-plan §10 Phase 2, item 3).
//
// Every provider — GPU or VPS, and every "active" set — is ONE row in this table.
// Adding a provider (e.g. Vultr next) is a single entry here: zero changes to the
// broker, reaper, teardown, or sweeper. Before this, a new provider had to be added
// to a resolver map AND the correct one of three separate ACTIVE_* arrays; missing
// either silently leaked boxes (unknown provider → teardown threw and the row was
// deleted, or the orphan-reconcile loop never listed the provider).
//
// The two PROVIDER INTERFACES stay separate (GpuProvider vs VpsProvider) — a GPU box
// and a bundled-bandwidth VPS hub genuinely differ (the VPS has a billable primary IP
// + fixed ports + a different destroy signature). The REGISTRY unifies REGISTRATION
// and RESOLUTION, not the interfaces.
//
// `roles` declares which active set a GPU provider belongs to. There is now ONE GPU
// role — 'gpu': the VPS-hub GPU backend that receives an mpegts-over-TCP bridge on
// :8899 and returns one H.264 stream. Because the bridge is TCP (not SRT/UDP), Vast
// and RunPod are interchangeable backends here — a TCP-only host is fine. VPS
// providers have one implicit role (hub); `roles` is unused for them.
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderKind = 'gpu' | 'vps'

type GpuRole = 'gpu'

interface RegistryEntry {
  kind: ProviderKind
  provider: GpuProvider | VpsProvider
  roles: GpuRole[]
}

const REGISTRY: RegistryEntry[] = [
  // The GPU backend ingests an mpegts-over-TCP bridge on :8899 from the hub (SRT is
  // OBS→hub only), so a TCP-only host qualifies — Vast and RunPod are interchangeable.
  { kind: 'gpu', provider: vastProvider, roles: ['gpu'] },
  { kind: 'gpu', provider: runpodProvider, roles: ['gpu'] },
  // VPS hubs (VPS-as-the-Hub). Hetzner first; Vultr later is one more entry here.
  { kind: 'vps', provider: hetznerProvider, roles: [] },
]

function gpuProvidersWithRole(role: GpuRole): GpuProvider[] {
  return REGISTRY.filter(e => e.kind === 'gpu' && e.roles.includes(role)).map(e => e.provider as GpuProvider)
}

// Active sets, DERIVED from the single registry above (no separately-maintained arrays).
export const ACTIVE_GPU_PROVIDERS: GpuProvider[] = gpuProvidersWithRole('gpu')
export const ACTIVE_VPS_PROVIDERS: VpsProvider[] =
  REGISTRY.filter(e => e.kind === 'vps').map(e => e.provider as VpsProvider)

/** Resolve a provider of a given KIND by name. The one kind+name resolver the registry
 *  exists for — the sweeper/teardown pick `kind` from the table they're reaping and never
 *  branch on a provider-name literal.
 *
 *  STRICT: an unknown OR EMPTY/NULL name THROWS. There is no "blank = Vast" fallback — once
 *  a second provider exists, guessing Vast for a blank routes e.g. a Hetzner/RunPod box id
 *  to Vast.destroy() (a no-op against the wrong API → the box leaks and bills forever).
 *  Every box now stamps its provider AT CREATE, so a blank reaching here is a BUG we want
 *  to surface loudly, not paper over. Legacy blank rows are backfilled to 'vast' by
 *  migration 000011 (they genuinely predate multi-provider and are all Vast). */
export function resolveProvider(kind: ProviderKind, name: string | null | undefined): GpuProvider | VpsProvider {
  const e = name ? REGISTRY.find(r => r.kind === kind && r.provider.name === name) : undefined
  if (!e) {
    throw new Error(
      `Unknown ${kind} provider '${name ?? '(null)'}' — refusing to route teardown to the wrong API ` +
      `(a blank/unknown provider used to silently fall back to Vast and leak the box). ` +
      `Register it in providers/index.ts, or check the box was stamped at create.`,
    )
  }
  return e.provider
}

/** Resolve the GPU provider that owns an instance (for stop/teardown). Strict — see
 *  resolveProvider. */
export function getProvider(name: string | null | undefined): GpuProvider {
  return resolveProvider('gpu', name) as GpuProvider
}

/** Resolve the VPS provider that owns a relay_nodes(role='vps_hub') box. Strict — there
 *  is no safe default for releasing a billable server + its primary IPv4. */
export function getVpsProvider(name: string | null | undefined): VpsProvider {
  return resolveProvider('vps', name) as VpsProvider
}
