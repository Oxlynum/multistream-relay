import { createServerClient } from '@/lib/supabase'
import { checkRateLimit } from '@/lib/rate-limit'
import { createHash, randomBytes } from 'crypto'

// Step 2 of device linking: the logged-in /link page calls this when the user
// clicks "Authorize". We mint a short-lived one-time code bound to the user and
// the plugin's PKCE challenge. The browser then carries the code to the plugin's
// loopback; the plugin redeems it at /api/link/token with the matching verifier.
const CODE_TTL_MS = 2 * 60 * 1000 // 2 minutes

export async function POST(request: Request) {
  const supabase = createServerClient()

  // Must be a real logged-in user (Supabase session from the /link page).
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  if (!(await checkRateLimit(`link-authorize:${user.id}`, 10, 60))) {
    return Response.json({ error: 'Too many requests. Slow down.' }, { status: 429 })
  }

  const body = await request.json().catch(() => ({}))
  const challenge = typeof body.challenge === 'string' ? body.challenge.trim() : ''
  // PKCE S256 challenge is base64url(sha256(...)) → 43 chars, url-safe alphabet.
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return Response.json({ error: 'Invalid PKCE challenge' }, { status: 400 })
  }

  const code = randomBytes(32).toString('base64url')
  const codeHash = createHash('sha256').update(code).digest('hex')

  const { error } = await supabase.from('device_link_codes').insert({
    code_hash: codeHash,
    user_id: user.id,
    code_challenge: challenge,
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  })
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ code })
}
