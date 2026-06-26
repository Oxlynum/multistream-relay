import { createServerClient } from '@/lib/supabase'
import { teardownInstance } from '@/lib/pod-teardown'
import { ACTIVE_PROVIDERS, getProvider } from '@/lib/providers'
import type { RacerEntry } from '@/lib/gpu-broker'

// The independent backstop. Runs daily (Vercel Hobby caps crons at once/day) and
// destroys any pod that the in-pod safeties can't catch — chiefly a pod that has
// stopped phoning home (agent crashed, lost network, host node died) and would
// otherwise bill forever. The live agent self-destructs within seconds on
// idle/credits/max-session, so this only matters when the agent is dead; for
// faster reaping of that case, move to a Pro plan (every-minute) or point an
// external uptime pinger at this endpoint. Endpoint is safe to call any time.

// No heartbeat for this long → the pod is gone or unreachable; destroy it.
const STALE_S = 150
// Provisioned but never paired within this window → boot failed; destroy it.
const NEVER_PAIRED_S = 180
const IDLE_GRACE_S = 5 * 60
// Backstop for the confirmable 12h deadline: kill only well past it (the live
// heartbeat already enforces the exact deadline for healthy pods).
const MAX_SESSION_GRACE_S = 60

export async function GET(request: Request) {
  // Protect the endpoint. Vercel cron includes `Authorization: Bearer $CRON_SECRET`
  // when CRON_SECRET is set. If unset (local/dev), allow through.
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${secret}`) {
      return new Response('Unauthorized', { status: 401 })
    }
  }

  const supabase = createServerClient()
  const { data: instances } = await supabase
    .from('gpu_instances')
    .select('user_id, last_seen_at, created_at, idle_since, streaming, status, max_session_at')
    .neq('status', 'stopped')

  const now = Date.now()
  const reaped: { user_id: string; reason: string }[] = []

  for (const inst of instances ?? []) {
    const lastSeen = inst.last_seen_at ? new Date(inst.last_seen_at).getTime() : null
    const createdAt = inst.created_at ? new Date(inst.created_at).getTime() : now
    const idleSince = inst.idle_since ? new Date(inst.idle_since).getTime() : null
    const maxSessionAt = inst.max_session_at ? new Date(inst.max_session_at).getTime() : null

    let reason = ''
    if (lastSeen === null) {
      // Never checked in. Give it a provisioning grace window, then kill.
      if ((now - createdAt) / 1000 > NEVER_PAIRED_S) reason = 'never_paired'
    } else if ((now - lastSeen) / 1000 > STALE_S) {
      reason = 'stale_heartbeat'
    } else if (maxSessionAt && now > maxSessionAt + MAX_SESSION_GRACE_S * 1000) {
      reason = 'max_session'
    } else if (!inst.streaming && idleSince && (now - idleSince) / 1000 > IDLE_GRACE_S) {
      reason = 'idle_timeout'
    }

    if (reason) {
      await teardownInstance(inst.user_id, `reaper:${reason}`)
      reaped.push({ user_id: inst.user_id, reason })
    }
  }

  // ── Racer cleanup: destroy loser/failed racers from v2 races ──────────────
  // teardownInstance handles this on user-initiated stops; here we clean up
  // any that survived (e.g. the /ready handler's fire-and-forget failed).
  try {
    const { data: racerRows } = await supabase
      .from('gpu_instances')
      .select('user_id, racers')
      .neq('status', 'stopped')
    for (const row of racerRows ?? []) {
      const racers = (row.racers ?? []) as RacerEntry[]
      for (const racer of racers) {
        if ((racer.state === 'loser' || racer.state === 'failed') && racer.provider_id) {
          try {
            await getProvider(racer.provider).destroy(racer.provider_id)
            // Clear from the array so we don't re-attempt next run.
            const updatedRacers = racers.map(r =>
              r.provider_id === racer.provider_id ? { ...r, provider_id: '' } : r
            )
            await supabase.from('gpu_instances').update({ racers: updatedRacers }).eq('user_id', row.user_id)
          } catch { /* best effort */ }
        }
      }
    }
  } catch (e) {
    console.error('[reaper] racer cleanup failed:', e)
  }

  // ── Orphan reconcile: destroy any provider instance with no gpu_instances row ──
  // The only path that can see a pod the DB doesn't know about (the classic
  // "created but the row write lost a race / the function died"). Runs across
  // EVERY active provider so a stray rental can't bill forever. Safe against the provisioning window
  // because provision reserves the row BEFORE creating the pod, so a mid-provision
  // instance's user always has a row — matched here by the user-prefix baked into
  // the instance name (`slimcast-<8 chars>`).
  const orphans: string[] = []
  try {
    const { data: allRows } = await supabase
      .from('gpu_instances')
      .select('user_id, provider_id, racers')
    // Include racer pod IDs (v2 race path) so active racers aren't orphan-destroyed.
    const knownPodIds = new Set([
      ...(allRows ?? []).map(r => r.provider_id).filter(Boolean),
      ...(allRows ?? []).flatMap(r =>
        ((r.racers ?? []) as RacerEntry[])
          .map(racer => racer.provider_id)
          .filter(Boolean)
      ),
    ])
    const knownUserPrefixes = new Set((allRows ?? []).map(r => r.user_id?.slice(0, 8)).filter(Boolean))

    for (const provider of ACTIVE_PROVIDERS) {
      let live: Array<{ id: string; name: string }>
      try {
        live = await provider.listInstances()
      } catch (e) {
        console.error(`[reaper] ${provider.name} listInstances failed:`, e)
        continue
      }
      for (const pod of live) {
        if (!pod.name?.startsWith('slimcast-')) continue
        if (knownPodIds.has(pod.id)) continue
        const prefix = pod.name.slice('slimcast-'.length)
        if (knownUserPrefixes.has(prefix)) continue // row exists (mid-provision) — leave it
        try {
          await provider.destroy(pod.id)
          orphans.push(`${provider.name}:${pod.id}`)
        } catch (e) {
          console.error(`[reaper] failed to destroy orphan ${provider.name} instance ${pod.id}:`, e)
        }
      }
    }
  } catch (e) {
    console.error('[reaper] orphan reconcile failed:', e)
  }

  return Response.json({ ok: true, checked: instances?.length ?? 0, reaped, orphans })
}
