import type { NextRequest } from 'next/server'
import { authenticateAgentDetailed } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { triggerAutoRefill } from '@/app/api/credits/auto-refill/route'
import { teardownInstance, sweepStalePods } from '@/lib/pod-teardown'
import { transcodeCount, burnRatePerSec, type OutputStatus } from '@/lib/billing'

// Never bill more than this many seconds per heartbeat, even if the previous
// heartbeat was long ago (missed beats / restart) — avoids surprise overcharges.
const MAX_BILL_INTERVAL_S = 60

// ── Safety caps (the pod tears itself down when any of these trips) ───────────
// A pod that's up but not streaming this long is abandoned → destroy it.
const IDLE_GRACE_S = 5 * 60             // 5m
// The 12h session cap is now a confirmable deadline (max_session_at). The dock
// surfaces a "still streaming?" prompt during its final 30m via /api/gpu/status;
// the heartbeat below only hard-kills once max_session_at has actually passed.

// Agent posts heartbeats here every 10s with live stream status.
export async function POST(request: NextRequest) {
  const authed = await authenticateAgentDetailed(request)
  if (!authed) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { userId, label } = authed
  const isPodAgent = label === 'pod'

  const body = await request.json().catch(() => ({}))
  const { outputs = [], streaming = false } = body as {
    outputs: OutputStatus[]
    streaming: boolean
  }
  console.log(`[agent/status] label=${label} streaming=${streaming} outputs=${outputs.length}`)

  const supabase = createServerClient()

  const { data: instance } = await supabase
    .from('gpu_instances')
    .select('last_seen_at, burn_rate, created_at, idle_since, session_id, max_session_at')
    .eq('user_id', userId)
    .maybeSingle()

  const { data: profile } = await supabase
    .from('profiles')
    .select('streaming_credits_seconds')
    .eq('id', userId)
    .single()

  let creditsSeconds = profile?.streaming_credits_seconds ?? 0
  let burnRate = instance?.burn_rate ?? 0

  const now = Date.now()

  // --- Billing: only the pod agent is the billing clock ---------------------
  // (The dashboard / OBS dock also poll this endpoint with the 'user' key — they
  //  must read state but never advance the clock, deduct, or tear anything down.)
  if (isPodAgent) {
    burnRate = burnRatePerSec(transcodeCount(outputs), streaming)

    const last = instance?.last_seen_at ? new Date(instance.last_seen_at).getTime() : now
    const elapsed = Math.min(Math.max(0, (now - last) / 1000), MAX_BILL_INTERVAL_S)
    const deduct = Math.round(burnRate * elapsed)

    // DEV billing bypass — three explicit guards so this can ONLY ever match one
    // specific account and can never be triggered by a blank/malformed env var:
    //   1. Env var must be a well-formed UUID (rejects empty string, "undefined",
    //      wildcards, or anything that isn't a real Supabase user ID).
    //   2. userId must be truthy (guards against any auth edge case returning null).
    //   3. Comparison is exact === equality — no prefix match, no type coercion.
    // If the env var is not set, UUID_RE.test('') is false → bypass never fires.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const devBypassId = process.env.SLIMCAST_DEV_NO_BILLING_USER_ID ?? ''
    const devNoBilling =
      !!userId &&
      UUID_RE.test(devBypassId) &&
      devBypassId === userId
    if (devNoBilling) console.log(`[billing] dev bypass active for ${userId} — deduction of ${deduct}s skipped`)
    if (deduct > 0 && !devNoBilling) {
      creditsSeconds = Math.max(0, creditsSeconds - deduct)
      await supabase
        .from('profiles')
        .update({ streaming_credits_seconds: creditsSeconds })
        .eq('id', userId)
    }

    // idle_since: cleared while streaming, set the moment we stop streaming.
    const idleSince = streaming
      ? null
      : (instance?.idle_since ?? new Date(now).toISOString())

    // --- Session recording (history + billing audit trail) -----------------
    // Open on the first streaming beat, accumulate each beat, close on stop.
    // The same heartbeat that bills also records, so the two never diverge.
    let sessionId = instance?.session_id ?? null
    const livePlatforms = Array.from(
      new Set(outputs.flatMap(o => o.platforms ?? []))
    )

    if (streaming && !sessionId) {
      const { data: opened } = await supabase
        .from('stream_sessions')
        .insert({
          user_id: userId,
          started_at: new Date(now).toISOString(),
          duration_seconds: 0,
          credits_deducted: 0,
          platforms: livePlatforms,
        })
        .select('id')
        .single()
      sessionId = opened?.id ?? null
    } else if (streaming && sessionId) {
      const { data: open } = await supabase
        .from('stream_sessions')
        .select('started_at, credits_deducted, platforms')
        .eq('id', sessionId)
        .maybeSingle()
      if (open) {
        const merged = Array.from(new Set([...(open.platforms ?? []), ...livePlatforms]))
        await supabase
          .from('stream_sessions')
          .update({
            duration_seconds: Math.round((now - new Date(open.started_at).getTime()) / 1000),
            credits_deducted: (open.credits_deducted ?? 0) + deduct,
            platforms: merged,
          })
          .eq('id', sessionId)
      } else {
        // Row vanished (history pruned) — stop tracking it.
        sessionId = null
      }
    } else if (!streaming && sessionId) {
      // Stream stopped: close the session, keep the last accumulated duration
      // (don't extend it across the idle gap).
      await supabase
        .from('stream_sessions')
        .update({ ended_at: new Date(now).toISOString() })
        .eq('id', sessionId)
        .is('ended_at', null)
      sessionId = null
    }

    await supabase
      .from('gpu_instances')
      .update({
        last_seen_at: new Date(now).toISOString(),
        burn_rate: burnRate,
        outputs,
        streaming,
        idle_since: idleSince,
        session_id: sessionId,
      })
      .eq('user_id', userId)

    // Last-ditch credit save before we enforce exhaustion.
    if (streaming && creditsSeconds < 3600) {
      const refilled = await triggerAutoRefill(userId)
      if (refilled) {
        const { data: updated } = await supabase
          .from('profiles')
          .select('streaming_credits_seconds')
          .eq('id', userId)
          .single()
        creditsSeconds = updated?.streaming_credits_seconds ?? creditsSeconds
      }
    }

    // ── SAFETY: destroy the pod (don't just stop) on any hard condition ──────
    const idleFor = idleSince ? (now - new Date(idleSince).getTime()) / 1000 : 0
    // The 12h cap is now a confirmable deadline: we only kill once it's actually
    // passed. The "still streaming?" prompt during the final 30m is surfaced by
    // /api/gpu/status (what the dock polls); confirming pushes max_session_at out.
    const maxSessionAt = instance?.max_session_at ? new Date(instance.max_session_at).getTime() : null

    let killReason = ''
    if (creditsSeconds <= 0) killReason = 'credits_exhausted'
    else if (maxSessionAt && now >= maxSessionAt) killReason = 'session_expired'
    else if (!streaming && idleFor > IDLE_GRACE_S) killReason = 'idle_timeout'

    if (killReason) {
      await teardownInstance(userId, `heartbeat:${killReason}`)
      return Response.json({ command: 'stop', reason: killReason, credits_seconds: creditsSeconds, burn_rate: 0 })
    }
  }

  // Inline sweep: catch dead pods from other users without a paid cron.
  // Runs on every pod heartbeat (every 10s per active pod). Fast single DB
  // read; teardowns only fire for truly stale pods. Don't await — the sweep
  // must not block the heartbeat response that the agent is waiting for.
  if (isPodAgent) sweepStalePods().catch(e => console.error('[sweep] error:', e))

  // Check for a pending manual control command.
  const { data: cmd } = await supabase
    .from('agent_commands')
    .select('id, command')
    .eq('user_id', userId)
    .is('executed_at', null)
    .order('issued_at', { ascending: true })
    .limit(1)
    .single()

  if (cmd) {
    await supabase
      .from('agent_commands')
      .update({ executed_at: new Date().toISOString() })
      .eq('id', cmd.id)

    return Response.json({ command: cmd.command, credits_seconds: creditsSeconds, burn_rate: burnRate })
  }

  return Response.json({ command: null, credits_seconds: creditsSeconds, burn_rate: burnRate, outputs })
}
