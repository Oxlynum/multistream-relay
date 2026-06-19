import type { NextRequest } from 'next/server'
import { authenticateAgentDetailed } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { triggerAutoRefill } from '@/app/api/credits/auto-refill/route'
import { transcodeCount, burnRatePerSec, type OutputStatus } from '@/lib/billing'

// Never bill more than this many seconds per heartbeat, even if the previous
// heartbeat was long ago (missed beats / restart) — avoids surprise overcharges.
const MAX_BILL_INTERVAL_S = 60

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
    .select('last_seen_at, burn_rate')
    .eq('user_id', userId)
    .maybeSingle()

  const { data: profile } = await supabase
    .from('profiles')
    .select('streaming_credits_seconds')
    .eq('id', userId)
    .single()

  let creditsSeconds = profile?.streaming_credits_seconds ?? 0
  let burnRate = instance?.burn_rate ?? 0

  // --- Billing: only the pod agent is the billing clock ---------------------
  // (The dashboard / OBS dock also poll this endpoint with the 'user' key — they
  //  must read state but never advance the clock or deduct.)
  if (isPodAgent) {
    burnRate = burnRatePerSec(transcodeCount(outputs), streaming)

    const now = Date.now()
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

    await supabase
      .from('gpu_instances')
      .update({ last_seen_at: new Date(now).toISOString(), burn_rate: burnRate })
      .eq('user_id', userId)
  }

  // Credits exhausted — stop the stream.
  if (streaming && creditsSeconds <= 0) {
    return Response.json({ command: 'stop', reason: 'credits_exhausted', credits_seconds: 0, burn_rate: burnRate })
  }

  // Trigger auto-refill when under 1 hour remaining while streaming.
  if (isPodAgent && streaming && creditsSeconds < 3600) {
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
