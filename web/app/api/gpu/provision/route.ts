import { createServerClient } from '@/lib/supabase'
import { generateApiKey, hashApiKey, authenticateUserOrAgent } from '@/lib/agent-auth'
import { provisionGpu } from '@/lib/gpu-broker'
import { FALLBACK_LAT, FALLBACK_LON } from '@/lib/datacenters'

export async function POST(request: Request) {
  const supabase = createServerClient()

  const userId = await authenticateUserOrAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: existing } = await supabase
    .from('gpu_instances')
    .select('id, status')
    .eq('user_id', userId)
    .single()

  if (existing?.status === 'running') {
    return Response.json({ error: 'Streaming server is already running' }, { status: 409 })
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
    // Clean up the unused pod key; tell the client to retry.
    await supabase.from('agent_api_keys').delete().eq('key_hash', podKeyHash)
    return Response.json(
      { error: 'No GPU capacity available right now. Please retry in a moment.', detail: result.error },
      { status: 503 },
    )
  }

  const row = {
    provider_id: result.podId!,
    pod_key_hash: podKeyHash,
    status: 'provisioning',
    ip_address: result.ip ?? null,
    provider: result.provider,
    gpu_type: result.gpuKey,
    datacenter: result.datacenter,
    last_seen_at: null,
  }

  if (existing) {
    await supabase.from('gpu_instances').update(row).eq('user_id', userId)
  } else {
    await supabase.from('gpu_instances').insert({ user_id: userId, ...row })
  }

  return Response.json({
    ok: true,
    gpu: result.gpuKey,
    datacenter: result.datacenter,
    attempts: result.attempts,
  })
}
