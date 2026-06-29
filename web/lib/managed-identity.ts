// Single source of truth for the "is this cloud box ours, and whose is it?" identity
// that the row-less orphan reconcile depends on (termination-system-plan §10 Phase 2,
// item 2). Before this, the literals 'slimcast-' / 'slimcast-hub-' and the owner-prefix
// parsing were inlined at every create site AND re-derived by hand in the reaper. A
// divergence between the two silently blinds the ONLY DB-independent orphan catchall —
// a leaked box bills forever. Keep create + reconcile pinned to these helpers so they
// can never drift.
//
// Why owner-id lives IN the name (not just a boolean label): the reaper's mid-provision
// guard needs to know WHOSE a freshly-created box is, to avoid destroying a box whose
// DB row is still being written. Vast and RunPod expose no server-side label/tag system
// (Vast has a single free-form `label` field = the name; RunPod only a name), so the
// owner id must be encoded in the name string. Hetzner additionally carries a
// `managed-by:slimcast` label (server-side filterable), but the name still carries the
// owner id for the same guard.

// The label value stamped on every provider resource we own (Hetzner label, and the
// name prefix on Vast/RunPod). A box/IP/aux-resource NOT carrying this is never ours
// and the reaper must never touch it.
export const MANAGED_BY = 'slimcast'

// GPU pod / GPU-backend box name: `slimcast-<userId8>`.
export const POD_PREFIX = `${MANAGED_BY}-`
// VPS hub box name: `slimcast-hub-<region>-<hubId8>`. Note it ALSO starts with POD_PREFIX,
// so pod-name matching must explicitly exclude hub names (ownerOfPodName does).
export const HUB_PREFIX = `${MANAGED_BY}-hub-`

/** The name to stamp on a GPU pod / GPU-backend box at create. The reaper matches and
 *  parses this exact shape, so always build the name here. */
export function podName(userId: string): string {
  return `${POD_PREFIX}${userId.slice(0, 8)}`
}

/** The name to stamp on a VPS hub box at create. Region ids carry no hyphens
 *  (fsn1/nbg1/hel1), so the trailing `-<hubId8>` is unambiguously the owner tail. */
export function hubName(region: string, hubId: string): string {
  return `${HUB_PREFIX}${region}-${hubId.slice(0, 8)}`
}

/** Owner-id (8-char user prefix) parsed back out of a GPU box name, or null if the name
 *  isn't one of our pod names. Excludes hub names (which share the `slimcast-` prefix). */
export function ownerOfPodName(name: string | null | undefined): string | null {
  if (!name || !name.startsWith(POD_PREFIX)) return null
  if (name.startsWith(HUB_PREFIX)) return null   // a hub, not a pod
  return name.slice(POD_PREFIX.length) || null
}

/** Owner-id (8-char hub prefix) parsed back out of a VPS hub box name, or null if the
 *  name isn't one of our hub names. */
export function ownerOfHubName(name: string | null | undefined): string | null {
  if (!name || !name.startsWith(HUB_PREFIX)) return null
  return name.slice(HUB_PREFIX.length).split('-').pop() || null   // hubId8 tail
}
