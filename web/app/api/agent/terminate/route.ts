import type { NextRequest } from 'next/server'
import { authenticateAgent } from '@/lib/agent-auth'
import { teardownInstance } from '@/lib/pod-teardown'

// The pod proactively asks to be destroyed (its own idle/max-session watchdog).
// Authenticated by the pod's API key — it can only ever tear down its own pod.
export async function POST(request: NextRequest) {
  const userId = await authenticateAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const reason = typeof body.reason === 'string' ? body.reason : 'self'

  await teardownInstance(userId, `agent:${reason}`)
  return Response.json({ ok: true })
}
