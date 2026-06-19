import { authenticateUserOrAgent } from '@/lib/agent-auth'
import { teardownInstance } from '@/lib/pod-teardown'

export async function DELETE(request: Request) {
  const userId = await authenticateUserOrAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ok = await teardownInstance(userId, 'manual_stop')
  if (!ok) {
    return Response.json({ error: 'No streaming server found' }, { status: 404 })
  }

  return Response.json({ ok: true })
}
