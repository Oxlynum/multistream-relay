import { createServerClient } from '@/lib/supabase'
import { generateApiKey, hashApiKey, authenticateUserOrAgent } from '@/lib/agent-auth'
import { provisionGpu } from '@/lib/gpu-broker'
import { teardownInstance } from '@/lib/pod-teardown'
import { checkRateLimit } from '@/lib/rate-limit'
import { FALLBACK_LAT, FALLBACK_LON } from '@/lib/datacenters'

// A running pod is considered live (not reclaimable) only if it has heartbeat
// within this window. Past it the agent is presumed dead and the slot is free.
const FRESH_HEARTBEAT_MS = 150_000
// A provisioning row younger than this means another request is mid-boot; don't
// reclaim it (it would strand the in-flight pod). The boot/readiness gate is
// well under this, so a genuinely stuck claim is reclaimable after it.
const PROVISION_LOCK_MS = 3 * 60 * 1000
// Force-confirm window: a session is hard-killed at created_at + this.
const MAX_SESSION_MS = 12 * 60 * 60 * 1000

export async function POST(request: Request) {
  const supabase = createServerClient()

  const userId = await authenticateUserOrAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Rate limit: a handful of provisions per minute per user is plenty for a
  // human; this caps any scripted spam that would create orphan pods.
  if (!(await checkRateLimit(`provision:${userId}`, 5, 60))) {
    return Response.json({ error: 'Too many requests. Slow down.' }, { status: 429 })
  }

  // ── Payment gate: no pod may ever run without a card on file AND a way to
  // pay for it. This is the hard stop against "run pods without paying" and
  // against multi-account free-GPU abuse (a card is the anti-sybil signal). ──
  const { data: gate } = await supabase
    .from('profiles')
    .select('stripe_payment_method_id, streaming_credits_seconds, auto_refill_enabled')
    .eq('id', userId)
    .single()

  if (!gate?.stripe_payment_method_id) {
    return Response.json(
      { error: 'payment_method_required', message: 'Add a payment method before streaming.' },
      { status: 402 },
    )
  }
  const credits = gate.streaming_credits_seconds ?? 0
  if (credits <= 0 && !gate.auto_refill_enabled) {
    return Response.json(
      { error: 'out_of_credits', message: 'You are out of streaming time. Add credits or enable auto-refill.' },
      { status: 402 },
    )
  }

  // ── Atomic provisioning claim ──────────────────────────────────────────
  // The orphan-pod bug: if we created the pod before reserving the row, two
  // concurrent calls would each boot a pod but only one would be recorded —
  // the other bills forever, unseen by every teardown path. So we reserve the
  // row FIRST. The unique(user_id) constraint makes the insert the lock.
  const { data: existing } = await supabase
    .from('gpu_instances')
    .select('status, last_seen_at, created_at')
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) {
    const fresh =
      existing.last_seen_at &&
      Date.now() - new Date(existing.last_seen_at).getTime() < FRESH_HEARTBEAT_MS
    if (existing.status === 'running' && fresh) {
      return Response.json({ error: 'Streaming server is already running' }, { status: 409 })
    }
    // A recently-created provisioning row = another request is mid-boot. Don't
    // reclaim it (that could strand its in-flight pod) — tell the caller to wait.
    const provisioningRecently =
      existing.status === 'provisioning' &&
      existing.created_at &&
      Date.now() - new Date(existing.created_at).getTime() < PROVISION_LOCK_MS
    if (provisioningRecently) {
      return Response.json({ error: 'Streaming server is already starting' }, { status: 409 })
    }
    // Stale / stopped / errored row: destroy any old pod and free the slot so
    // the claim insert below can take it (never overwrite a row that still
    // points at a live pod — that's how orphans are born).
    await teardownInstance(userId, 'provision_reclaim')
  }

  // Insert-as-lock. If a concurrent request already claimed, this conflicts on
  // unique(user_id) and we bail WITHOUT creating a pod.
  const { data: claim, error: claimErr } = await supabase
    .from('gpu_instances')
    .insert({
      user_id: userId,
      provider_id: '',
      status: 'provisioning',
      max_session_at: new Date(Date.now() + MAX_SESSION_MS).toISOString(),
    })
    .select('id')
    .maybeSingle()

  if (claimErr || !claim) {
    return Response.json({ error: 'Streaming server is already starting' }, { status: 409 })
  }

  // From here on, the claim row exists. Any early return MUST release it.
  const releaseClaim = async () => {
    await supabase.from('gpu_instances').delete().eq('user_id', userId)
  }

  // Generate a fresh ephemeral key for the pod — separate from the user's
  // dashboard API key so provisioning doesn't invalidate the OBS plugin setup.
  const podRawKey = generateApiKey()
  const podKeyHash = hashApiKey(podRawKey)

  // Remove any stale pod key for this user before inserting the new one.
  await supabase
    .from('agent_api_keys')
    .delete()
    .eq('user_id', userId)
    .eq('label', 'pod')

  await supabase.from('agent_api_keys').insert({
    user_id: userId,
    key_hash: podKeyHash,
    label: 'pod',
  })

  // `||` not `??`: an empty-string env var should still fall back to the default.
  const imageTag = process.env.SLIMCAST_RELAY_IMAGE || 'ghcr.io/oxlynum/multistream-relay:latest'

  // Where the pod's agent phones home. Defaults to slimcast.com (not live yet),
  // so we pass this deployment's URL explicitly.
  const callbackUrl =
    process.env.SLIMCAST_AGENT_CALLBACK_URL ?? 'https://slimcast-oxlynum.vercel.app'

  // User location from Vercel's geolocation headers → provision the nearest
  // available GPU. Falls back to central US when headers are absent (local dev).
  const lat = Number(request.headers.get('x-vercel-ip-latitude')) || FALLBACK_LAT
  const lon = Number(request.headers.get('x-vercel-ip-longitude')) || FALLBACK_LON

  const result = await provisionGpu({
    lat,
    lon,
    name: `slimcast-${userId.slice(0, 8)}`,
    imageTag,
    env: [
      { key: 'SLIMCAST_API_KEY', value: podRawKey },
      { key: 'SLIMCAST_VERCEL_URL', value: callbackUrl },
    ],
  })

  if (!result.ok) {
    // Clean up the unused pod key AND release the claim so the user can retry.
    await supabase.from('agent_api_keys').delete().eq('key_hash', podKeyHash)
    await releaseClaim()
    return Response.json(
      { error: 'No GPU capacity available right now. Please retry in a moment.', detail: result.error },
      { status: 503 },
    )
  }

  // Pod is up — fill in the claim row with the real provider details. (Keep the
  // max_session_at the claim set, so the 12h confirm clock runs from claim time.)
  await supabase
    .from('gpu_instances')
    .update({
      provider_id: result.podId!,
      pod_key_hash: podKeyHash,
      status: 'provisioning',
      ip_address: result.ip ?? null,
      provider: result.provider,
      gpu_type: result.gpuKey,
      datacenter: result.datacenter,
      last_seen_at: null,
    })
    .eq('user_id', userId)

  return Response.json({
    ok: true,
    gpu: result.gpuKey,
    datacenter: result.datacenter,
    attempts: result.attempts,
  })
}
