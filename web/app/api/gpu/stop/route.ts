import { teardownInstance } from '@/lib/pod-teardown'
import { authenticateUserOrAgent } from '@/lib/agent-auth'

export async function POST(request: Request) {
  const userId = await authenticateUserOrAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Route through the single, idempotent, hub-aware teardown: a VPS-hub tenant gets
  // a LOGICAL detach (decrement the shared hub's refcount, never destroy the box),
  // while a legacy GPU pod is fully destroyed. The old path called
  // getProvider(provider).stop(provider_id) directly, which for a hub tenant
  // (provider='vast', provider_id='') was a no-op that skipped detach_from_hub and
  // permanently inflated the hub refcount, blocking scale-to-zero (review #19).
  const torn = await teardownInstance(userId, 'manual_stop')
  if (!torn) {
    return Response.json({ error: 'No streaming server found' }, { status: 404 })
  }

  return Response.json({ ok: true })
}
