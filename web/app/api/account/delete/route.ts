import { createServerClient } from '@/lib/supabase'
import { teardownAllForUser } from '@/lib/pod-teardown'
import { stripe } from '@/lib/stripe'
import { checkRateLimit } from '@/lib/rate-limit'

// POST /api/account/delete — permanently delete the authenticated user's account.
//
// Order is load-bearing (each step makes the next safe):
//   1. AUTH — session bearer token only (never an agent key; an agent must not be able to
//      self-delete the human's account).
//   2. BALANCE GUARD — refuse while purchased tokens remain UNLESS the user explicitly
//      acknowledges forfeiting them (`forfeitBalance: true`). streaming_credits is the
//      purchased balance; the subscription allotment is not money the user paid per-token
//      and is not guarded (it's canceled with the sub below).
//   2b. SHARED-HUB GUARD — refuse while the user hosts a shared VPS hub serving OTHER live
//      tenants (the auth CASCADE would revoke the hub's spawner-filed key and strand them).
//   3. STOP BILLING — cancel the Stripe subscription IMMEDIATELY so a deleted account can
//      never keep charging the card. Abort the whole delete if this fails (better to leave
//      the account intact and retryable than to delete it while billing continues).
//   4. SHUT OFF CLOUD BOXES — teardownAllForUser destroys every rented box BEFORE the row
//      CASCADE drops the rows (which would leak the boxes — they'd bill forever).
//   5. CASCADE DELETE — deleting the auth user cascades profiles → every child table
//      (platform_connections, stream_sessions, agent_api_keys, gpu_instances, …) via the
//      profiles.id → auth.users(id) ON DELETE CASCADE chain.
export async function POST(request: Request) {
  const supabase = createServerClient()

  // 1. Auth — session token ONLY.
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  if (!(await checkRateLimit(`account-delete:${user.id}`, 5, 60))) {
    return Response.json({ error: 'Too many requests. Slow down.' }, { status: 429 })
  }

  const body = await request.json().catch(() => ({})) as { forfeitBalance?: boolean }

  const { data: profile } = await supabase
    .from('profiles')
    .select('streaming_credits, stripe_subscription_id')
    .eq('id', user.id)
    .maybeSingle()

  // 2. Balance guard — block unless the user acknowledges forfeiting their balance.
  const balance = Number(profile?.streaming_credits ?? 0)
  if (balance > 0 && !body.forfeitBalance) {
    return Response.json({ error: 'balance_remaining', balance }, { status: 409 })
  }

  // 2b. Shared-hub guard — refuse while the user hosts a SHARED VPS hub that still serves
  // OTHER live tenants. The hub's 'vps' key is filed under the spawner (agent_api_keys
  // has no hub identity of its own), so deleting this user — via the auth.admin.deleteUser
  // CASCADE — would revoke the hub's only credential, stranding every other tenant on it.
  // Block until the hub is idle (it scales to zero on its own once its last lease drops),
  // rather than silently killing unrelated users' streams. (Inert until SLIMCAST_VPS_HUB:
  // no 'vps' keys exist while it's off.)
  const { data: hubKeys } = await supabase
    .from('agent_api_keys')
    .select('instance_id')
    .eq('user_id', user.id)
    .eq('label', 'vps')
  for (const k of hubKeys ?? []) {
    if (!k.instance_id) continue
    const { data: otherTenants } = await supabase
      .from('gpu_instances')
      .select('user_id')
      .eq('vps_hub_id', k.instance_id)
      .neq('user_id', user.id)
      .gt('renew_deadline', new Date().toISOString())
      .limit(1)
    if (otherTenants && otherTenants.length > 0) {
      return Response.json({ error: 'hosting_shared_hub' }, { status: 409 })
    }
  }

  // 3. Cancel the subscription immediately (stop billing) — abort only on a GENUINE failure.
  // stripe.subscriptions.cancel is NOT idempotent: a stale id (a missed/late
  // customer.subscription.deleted webhook never nulled stripe_subscription_id, an
  // out-of-band dashboard cancel, a naturally-ended sub) makes Stripe throw
  // resource_missing / "already canceled". The desired end state — no active sub — is
  // already true in those cases, so treat them as success; otherwise a stale id would
  // permanently lock the user out of deleting their account (an unsatisfiable erasure path).
  if (profile?.stripe_subscription_id) {
    try {
      await stripe.subscriptions.cancel(profile.stripe_subscription_id)
    } catch (e) {
      const err = e as { code?: string; raw?: { code?: string }; message?: string }
      const code = err?.code ?? err?.raw?.code
      const benign = code === 'resource_missing' ||
        /already canceled|no such subscription/i.test(err?.message ?? '')
      if (!benign) {
        console.error(`[account/delete] subscription cancel failed for ${user.id}:`, e)
        return Response.json({ error: 'subscription_cancel_failed' }, { status: 502 })
      }
      // Sub already gone — fall through and continue the delete.
      console.warn(`[account/delete] subscription ${profile.stripe_subscription_id} already canceled/missing — continuing`)
    }
  }

  // 4. Destroy every cloud box the user owns BEFORE the cascade drops the rows.
  await teardownAllForUser(user.id)

  // 5. Delete the auth user → cascades to profiles + all child tables. Service-role only.
  const { error } = await supabase.auth.admin.deleteUser(user.id)
  if (error) {
    console.error(`[account/delete] auth deleteUser failed for ${user.id}:`, error)
    return Response.json({ error: 'delete_failed' }, { status: 500 })
  }

  console.log(`[account/delete] deleted account ${user.id} (forfeited ${balance} tokens)`)
  return Response.json({ ok: true })
}
