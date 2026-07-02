import { createServerClient } from '@/lib/supabase'
import { createHash } from 'crypto'

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}

export function generateApiKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Only human-held key labels may authenticate as a *user*. Node keys ('vps'/'gpu')
// and the legacy all-in-one 'pod' key resolve exclusively through authenticateNode —
// they must NEVER stand in for their spawner's user (H2). Without this, an untrusted
// rented GPU holding its own 'gpu' key could call GET /api/gpu/status and read the
// live srt_url with its ingest_key + srt_passphrase (hijacking the OBS source), or
// stop/provision/read settings as the user — defeating the "GPU never receives ingress
// credentials" guarantee.
const USER_KEY_LABELS = new Set(['user', 'device'])

/** Validate a raw API key from Authorization header and return the user_id. */
export async function authenticateAgent(request: Request): Promise<string | null> {
  const detail = await authenticateAgentDetailed(request)
  if (!detail || !USER_KEY_LABELS.has(detail.label)) return null
  return detail.userId
}

/**
 * Like authenticateAgent but also returns the key's label ('pod' | 'user').
 * Billing only happens on the 'pod' agent's heartbeat — the dashboard/OBS dock
 * authenticate with the 'user' key and must not also deduct credits.
 */
export async function authenticateAgentDetailed(
  request: Request,
): Promise<{ userId: string; label: string } | null> {
  const auth = request.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return null

  const rawKey = auth.slice(7).trim()
  if (!rawKey) return null

  const keyHash = hashApiKey(rawKey)
  const supabase = createServerClient()

  const { data } = await supabase
    .from('agent_api_keys')
    .select('user_id, label')
    .eq('key_hash', keyHash)
    .single()

  if (!data?.user_id) return null
  return { userId: data.user_id, label: data.label ?? 'user' }
}

/**
 * VPS-as-the-Hub: authenticate a NODE key (a shared box's own key), NOT a user.
 *
 * A multi-tenant VPS hub has ONE 'vps' key that serves many tenants, so it has no
 * single owning user — folding it into the userId path (authenticateAgent) would
 * silently scope every hub request to one tenant. This sibling resolves the hub by
 * matching the key hash against vps_hubs.hub_key_hash. ('gpu' backend keys, Phase 2,
 * resolve the same way against relay_nodes.) Returns null for user/pod/device keys.
 */
export interface NodeAuth {
  nodeKeyHash: string
  role: 'vps' | 'gpu'
  hubId?: string        // set for role==='vps' (vps_hubs.id)
  nodeId?: string       // set for role==='gpu' (relay_nodes.id)
  instanceId?: string   // set for role==='gpu' (relay_nodes.instance_id → gpu_instances.id)
}

export async function authenticateNode(request: Request): Promise<NodeAuth | null> {
  const auth = request.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return null
  const rawKey = auth.slice(7).trim()
  if (!rawKey) return null

  const keyHash = hashApiKey(rawKey)
  const supabase = createServerClient()

  const { data: keyRow } = await supabase
    .from('agent_api_keys')
    .select('label')
    .eq('key_hash', keyHash)
    .single()
  if (!keyRow) return null

  if (keyRow.label === 'vps') {
    const { data: hub } = await supabase
      .from('vps_hubs')
      .select('id')
      .eq('hub_key_hash', keyHash)
      .maybeSingle()
    if (!hub?.id) return null
    return { nodeKeyHash: keyHash, role: 'vps', hubId: hub.id }
  }
  if (keyRow.label === 'gpu') {
    // Resolve the gpu_backend relay_nodes row this key owns (→ its parent session).
    const { data: node } = await supabase
      .from('relay_nodes')
      .select('id, instance_id')
      .eq('node_key_hash', keyHash)
      .eq('role', 'gpu_backend')
      .maybeSingle()
    if (!node?.id) return null
    return { nodeKeyHash: keyHash, role: 'gpu', nodeId: node.id, instanceId: node.instance_id }
  }
  return null   // user/pod/device keys are not node keys
}

/**
 * Resolve a user from either an agent API key (OBS plugin) or a Supabase
 * session JWT (dashboard) — both arrive in the Authorization: Bearer header.
 * Used by the GPU lifecycle + credit routes that both surfaces call.
 */
export async function authenticateUserOrAgent(request: Request): Promise<string | null> {
  // OBS plugin: raw agent key hashed against agent_api_keys.
  const agentUserId = await authenticateAgent(request)
  if (agentUserId) return agentUserId

  // Dashboard: Supabase JWT.
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null
  const supabase = createServerClient()
  const { data: { user } } = await supabase.auth.getUser(token)
  return user?.id ?? null
}
