import { vastProvider } from './vast'
import type { GpuProvider } from './types'

// Provider registry + resolver. Lives here (not in any single provider file) so
// the broker, reaper, and teardown depend on a provider-neutral module.
//
// SRT ingest (UDP) is the ONLY OBS→pod transport, so a provider is eligible only
// if its hosts forward UDP. Vast.ai is the sole provider today. RunPod was removed:
// its pods are TCP-only (no UDP/SRT — confirmed against RunPod's own docs), so it
// can never carry the SRT uplink. Vultr is the planned next UDP-capable addition.
export const ACTIVE_PROVIDERS: GpuProvider[] = [vastProvider]

const PROVIDERS: Record<string, GpuProvider> = {
  vast: vastProvider,
}

/** Resolve the provider that owns an existing instance (for stop/teardown).
 * Defaults to Vast — the only provider — so a row with a missing/legacy provider
 * value still tears down instead of throwing. */
export function getProvider(name: string | null | undefined): GpuProvider {
  return PROVIDERS[name ?? 'vast'] ?? vastProvider
}
