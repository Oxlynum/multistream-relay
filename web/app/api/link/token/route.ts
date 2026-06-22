import { createServerClient } from '@/lib/supabase'
import { generateApiKey, hashApiKey } from '@/lib/agent-auth'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { createHash } from 'crypto'

// Step 3 of device linking: the plugin redeems the one-time code, proving it
// holds the PKCE verifier. On success we issue a per-device agent key (returned
// once). No user session is involved — possession of code + verifier is the
// proof, exactly like an OAuth token exchange.
function base64urlSha256(input: string): string {
  return createHash('sha256').update(input).digest('base64url')
}

export async function POST(request: Request) {
  if (!(await checkRateLimit(`link-token:${clientIp(request)}`, 20, 60))) {
    return Response.json({ error: 'Too many requests. Slow down.' }, { status: 429 })
  }

  const body = await request.json().catch(() => ({}))
  const code = typeof body.code === 'string' ? body.code : ''
  const verifier = typeof body.verifier === 'string' ? body.verifier : ''
  const deviceName = typeof body.device_name === 'string' ? body.device_name.slice(0, 80) : null
  if (!code || !verifier) {
    return Response.json({ error: 'code and verifier required' }, { status: 400 })
  }

  const supabase = createServerClient()
  const codeHash = createHash('sha256').update(code).digest('hex')

  const { data: row } = await supabase
    .from('device_link_codes')
    .select('user_id, code_challenge, expires_at, consumed')
    .eq('code_hash', codeHash)
    .maybeSingle()

  if (!row) {
    console.error('[link/token] code not found')
    return Response.json({ error: 'invalid_or_expired_code' }, { status: 400 })
  }
  if (row.consumed) {
    console.error('[link/token] code already consumed')
    return Response.json({ error: 'code_already_used' }, { status: 400 })
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    console.error('[link/token] code expired')
    return Response.json({ error: 'code_expired' }, { status: 400 })
  }

  // PKCE: the verifier must hash to the challenge the plugin registered.
  if (base64urlSha256(verifier) !== row.code_challenge) {
    console.error('[link/token] pkce mismatch', { got: base64urlSha256(verifier).slice(0, 8), want: row.code_challenge.slice(0, 8) })
    return Response.json({ error: 'pkce_verification_failed' }, { status: 400 })
  }

  // Consume the code first (single-use). The eq on consumed=false makes this the
  // atomic guard against a redeemed-twice race.
  const { data: consumed } = await supabase
    .from('device_link_codes')
    .update({ consumed: true })
    .eq('code_hash', codeHash)
    .eq('consumed', false)
    .select('code_hash')
    .maybeSingle()
  if (!consumed) {
    return Response.json({ error: 'invalid_or_expired_code' }, { status: 400 })
  }

  // Issue a per-device key (revocable independently of other devices).
  const rawKey = generateApiKey()
  const { error: insErr } = await supabase.from('agent_api_keys').insert({
    user_id: row.user_id,
    key_hash: hashApiKey(rawKey),
    label: 'device',
    device_name: deviceName,
  })
  if (insErr) return Response.json({ error: insErr.message }, { status: 500 })

  return Response.json({ api_key: rawKey })
}
