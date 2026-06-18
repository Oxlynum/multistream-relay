import type { NextRequest } from 'next/server'
import { authenticateAgent } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { triggerAutoRefill } from '@/app/api/credits/auto-refill/route'

// Agent posts heartbeats here every 10s with live stream status.
export async function POST(request: NextRequest) {
  const userId = await authenticateAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const { outputs = [], streaming = false } = body as {
    outputs: Array<{ name: string; state: string }>
    streaming: boolean
  }

  const supabase = createServerClient()

  await supabase
    .from('gpu_instances')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('user_id', userId)

  const { data: profile } = await supabase
    .from('profiles')
    .select('streaming_credits_seconds')
    .eq('id', userId)
    .single()

  let creditsSeconds = profile?.streaming_credits_seconds ?? 0

  // Credits exhausted — stop the stream.
  if (streaming && creditsSeconds <= 0) {
    return Response.json({ command: 'stop', reason: 'credits_exhausted' })
  }

  // Trigger auto-refill when under 1 hour remaining while streaming.
  if (streaming && creditsSeconds < 3600) {
    const refilled = await triggerAutoRefill(userId)
    if (refilled) {
      // Re-read updated balance so the agent gets the correct value back.
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

    return Response.json({ command: cmd.command, credits_seconds: creditsSeconds })
  }

  return Response.json({ command: null, credits_seconds: creditsSeconds, outputs })
}
