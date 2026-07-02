import { after } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sweepExpiredLeases } from '@/lib/pod-teardown'
import { reconcileOrphans } from '@/lib/orphan-reconcile'
import { sendAlert, captureError } from '@/lib/observability'
import { timingSafeEqualStr } from '@/lib/crypto'

// The reconcile does cross-provider listInstances() (Vast + RunPod + Hetzner, ~8-10s each)
// + serial destroys + possible reraceGpuBackend provisions. Give it real budget so the
// guaranteed daily floor never gets cut mid-sweep (mirrors the provision route's 300s).
export const maxDuration = 300

// The DEMOTED-TO-FLOOR backstop (termination-system-plan §9.4). The primary reaper
// is now the heartbeat-driven sweepExpiredLeases() — fired from every live relay's
// status beat (pod / hub / gpu), it reaps any stale box within ~1 beat with no cron
// dependency. This daily cron remains for two things the lease alone can't cover:
//   1. The ALL-IDLE floor: if NOTHING is heartbeating, nothing drives the sweep —
//      so the cron runs sweepExpiredLeases() itself once a day as the safety net.
//   2. The ROW-LESS orphan reconcile: a box whose DB row was lost (create-then-die,
//      account-deletion CASCADE) has no renew_deadline to read, so the lease can't
//      see it — only provider.listInstances() vs the known rows can. Plus the v2
//      racer cleanup and the live-parent GPU re-race (richer geo-anchor logic).
// That reconcile now lives in lib/orphan-reconcile (enterprise-audit REL-05) and ALSO
// runs off the heartbeat sweep, throttled fleet-wide to ~15 min — so a leaked box is
// caught in minutes, not up to 24h. This cron calls the SAME function as the guaranteed
// daily floor (Vercel Hobby honours only a daily cron), plus the metrics-retention prune.
// Safe to call any time (it only reaps PAST-DEADLINE or genuinely-row-less boxes, so even
// an unauthenticated hit can't kill a healthy box).

export async function GET(request: Request) {
  // Protect the endpoint. Vercel cron sends `Authorization: Bearer $CRON_SECRET` when set.
  // Fail-CLOSED in production: if CRON_SECRET is unset in prod, refuse — this runs an expensive
  // ~300s cross-provider reconcile and must not be world-runnable. (Even an unauthenticated hit
  // can't kill a healthy box — the reaper only reaps past-deadline/row-less boxes — this is about
  // not leaving a costly endpoint open.) In dev (no secret) it stays open for convenience.
  const secret = process.env.CRON_SECRET
  const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
  if (secret) {
    const auth = request.headers.get('authorization') ?? ''
    if (!timingSafeEqualStr(auth, `Bearer ${secret}`)) {
      return new Response('Unauthorized', { status: 401 })
    }
  } else if (isProd) {
    console.error('[cron/reap] CRON_SECRET unset in production — refusing (set it to enable the cron).')
    return new Response('Unauthorized', { status: 401 })
  }

  const supabase = createServerClient()

  // ── Lease pass (the all-idle floor) ──────────────────────────────────────────
  // The single universal sweeper: gpu_instances (pod + hub-tenant leases), vps_hubs
  // (box lease + derived scale-to-zero) and gpu-backend nodes (dead-parent destroy).
  // Heartbeats drive it in real time; this daily call is purely the backstop for a
  // fully-idle fleet.
  // force:true — the floor must NOT be throttled and must NOT arm the recovery freeze (an
  // idle fleet's huge inter-beat gap is not a recovering herd; arming would freeze this very
  // sweep and leak a dead-but-rowed hub). It still defers if a heartbeat just armed a freeze.
  await sweepExpiredLeases({ force: true })

  // ── Row-less orphan reconcile + racer cleanup + mid-stream GPU re-race ───────
  // Shared with the heartbeat-throttled path (lib/orphan-reconcile, REL-05). This daily call
  // is the guaranteed floor; identical logic runs off the heartbeat sweep every ~15 min.
  const { orphans, orphanHubs, auxReleased, reapedGpuNodes, reracedGpuNodes } =
    await reconcileOrphans(supabase)

  // ── SCALE-02/REL-04: connection_metrics retention prune (daily floor) ────────
  // Deletes rows >24h. The heartbeat path also prunes (throttled ~30 min); this is the
  // all-idle floor so the table stays bounded even with no live traffic. BRIN-indexed on
  // recorded_at (…000004) so the DELETE range-scans the aged tail, not the whole heap.
  try { await supabase.rpc('prune_old_connection_metrics') }
  catch (e) { captureError('reaper.metrics_prune', e) }

  // ── REL-03: consume the reaper's own payload — alert on leaks + cost overruns ──
  // A daily digest fires when the reconcile actually destroyed orphans/leaked IPs (orphans
  // existing AT ALL means something is leaking — the operator must know) or any live box is
  // burning above the cost tripwire (margin alarm). Inert unless SLIMCAST_ALERT_WEBHOOK is
  // set; ≤1 alert per daily run.
  let overCostCount = 0
  try {
    const tripwire = Number(process.env.SLIMCAST_COST_ALERT_USD_HR ?? '2.0')
    const [{ count: gpuOver }, { count: hubOver }] = await Promise.all([
      supabase.from('gpu_instances').select('id', { count: 'exact', head: true })
        .neq('status', 'stopped').gt('cost_usd_hr', tripwire),
      supabase.from('vps_hubs').select('id', { count: 'exact', head: true })
        .neq('status', 'ended').gt('cost_usd_hr', tripwire),
    ])
    overCostCount = (gpuOver ?? 0) + (hubOver ?? 0)
  } catch (e) {
    captureError('reaper.cost_scan', e)
  }

  const leakCount = orphans.length + orphanHubs.length + auxReleased + reapedGpuNodes.length
  if (leakCount > 0 || overCostCount > 0) {
    after(() => sendAlert('SlimCast reaper digest', {
      orphan_gpus_destroyed: orphans.length,
      orphan_hubs_destroyed: orphanHubs.length,
      leaked_ips_released: auxReleased,
      dead_gpu_nodes_reaped: reapedGpuNodes.length,
      gpu_nodes_reraced: reracedGpuNodes.length,
      boxes_over_cost_tripwire: overCostCount,
    }))
  }

  return Response.json({ ok: true, orphans, orphanHubs, auxReleased, reapedGpuNodes, reracedGpuNodes, overCostCount })
}
