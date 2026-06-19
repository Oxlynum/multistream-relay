import type { NextRequest } from 'next/server'
import { authenticateAgentDetailed } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { triggerAutoRefill } from '@/app/api/credits/auto-refill/route'
import { teardownInstance } from '@/lib/pod-teardown'
import { transcodeCount, burnRatePerSec, type OutputStatus } from '@/lib/billing'

// Never bill more than this many seconds per heartbeat, even if the previous
// heartbeat was long ago (missed beats / restart) — avoids surprise overcharges.
const MAX_BILL_INTERVAL_S = 60

// ── Safety caps (the pod tears itself down when any of these trips) ───────────
// A streaming session can never outlive this, no matter what.
const MAX_SESSION_S = 12 * 60 * 60      // 12h
// A pod that's up but not streaming this long is abandoned → destroy it.
const IDLE_GRACE_S = 5 * 60             // 5m

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

  const supabase = createServerClient()

  const { data: instance } = await supabase
    .from('gpu_instances')
    .select('last_seen_at, burn_rate, created_at, idle_since')
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

    if (deduct > 0) {
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

    await supabase
      .from('gpu_instances')
      .update({
        last_seen_at: new Date(now).toISOString(),
        burn_rate: burnRate,
        outputs,
        streaming,
        idle_since: idleSince,
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
    const createdAt = instance?.created_at ? new Date(instance.created_at).getTime() : now
    const sessionAge = (now - createdAt) / 1000
    const idleFor = idleSince ? (now - new Date(idleSince).getTime()) / 1000 : 0

    let killReason = ''
    if (creditsSeconds <= 0) killReason = 'credits_exhausted'
    else if (sessionAge > MAX_SESSION_S) killReason = 'max_session'
    else if (!streaming && idleFor > IDLE_GRACE_S) killReason = 'idle_timeout'

    if (killReason) {
      await teardownInstance(userId, `heartbeat:${killReason}`)
      return Response.json({ command: 'stop', reason: killReason, credits_seconds: creditsSeconds, burn_rate: 0 })
    }
  }

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
