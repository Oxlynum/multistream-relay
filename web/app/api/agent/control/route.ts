import type { NextRequest } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { authenticateAgent } from '@/lib/agent-auth'

// Dashboard / OBS dock issues start/stop commands here.
// The agent picks them up on the next heartbeat (≤10s).
//
// Accepts either Bearer API key (OBS dock) or Supabase session cookie (dashboard).
export async function POST(request: NextRequest) {
  const supabase = createServerClient()
  let userId: string | null = null

  // Try API key auth first (OBS dock uses Bearer token).
  userId = await authenticateAgent(request)

  // Fall back to Supabase session (dashboard calls from browser).
  if (!userId) {
    const { data: { user } } = await supabase.auth.getUser(
      request.headers.get('x-supabase-auth') ?? ''
    )
    userId = user?.id ?? null
  }

  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const command = body.command as string | undefined

  if (command !== 'start' && command !== 'stop') {
    return Response.json({ error: 'command must be "start" or "stop"' }, { status: 400 })
  }

  await supabase.from('agent_commands').insert({ user_id: userId, command })

  return Response.json({ ok: true, command })
}
