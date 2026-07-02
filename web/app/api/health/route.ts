import { createServerClient } from '@/lib/supabase'
import { timingSafeEqualStr } from '@/lib/crypto'

// Liveness + (secret-gated) fleet/cost snapshot (enterprise-audit REL-03). This is the
// endpoint an uptime monitor / load balancer polls: 200 = DB reachable, 503 = DB or the
// service-role key is down. A caller presenting the CRON_SECRET bearer additionally gets a
// fleet + config snapshot for ops dashboards (kept behind the secret so fleet size and which
// env vars are configured aren't public). Counts only — never any user data.
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const startedAt = Date.now()
  const supabase = createServerClient()

  // Cheap reachability probe: a head-count of the 1-row coordinator table. If this errors,
  // the DB (or the service-role key) is unreachable → report unhealthy so a monitor can act.
  let dbOk = false
  let dbError: string | undefined
  try {
    const { error } = await supabase
      .from('sweep_coordinator')
      .select('id', { count: 'exact', head: true })
    dbOk = !error
    dbError = error?.message
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e)
  }

  const base = {
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk,
    latency_ms: Date.now() - startedAt,
    time: new Date().toISOString(),
  }

  const secret = process.env.CRON_SECRET
  const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
  // Fail-CLOSED in prod: the detailed snapshot (fleet counts, cost, which env vars are set) is
  // secret-gated. If CRON_SECRET is unset in production, treat the caller as UNauthed so only the
  // public liveness payload is returned — never expose fleet/config publicly. Dev (no secret): authed.
  const authed = secret
    ? timingSafeEqualStr(request.headers.get('authorization') ?? '', `Bearer ${secret}`)
    : !isProd

  // Public probe (or DB down): minimal payload, correct status code.
  if (!authed || !dbOk) {
    return Response.json(dbOk ? base : { ...base, db_error: dbError }, { status: dbOk ? 200 : 503 })
  }

  // Secret-gated snapshot: live fleet counts + the most expensive live box (margin signal)
  // + config flags + which critical env vars are present (booleans, never the values).
  const [hubs, gpus, sessions, costRows] = await Promise.all([
    supabase.from('vps_hubs').select('id', { count: 'exact', head: true }).neq('status', 'ended'),
    supabase.from('relay_nodes').select('id', { count: 'exact', head: true }).eq('role', 'gpu_backend'),
    supabase.from('gpu_instances').select('id', { count: 'exact', head: true }).neq('status', 'stopped'),
    supabase.from('vps_hubs').select('cost_usd_hr').neq('status', 'ended').not('cost_usd_hr', 'is', null)
      .order('cost_usd_hr', { ascending: false }).limit(1),
  ])

  const relayImage = process.env.SLIMCAST_RELAY_IMAGE ?? ''
  return Response.json({
    ...base,
    fleet: {
      active_hubs: hubs.count ?? null,
      gpu_backends: gpus.count ?? null,
      active_sessions: sessions.count ?? null,
      max_hub_cost_usd_hr: (costRows.data?.[0]?.cost_usd_hr as number | undefined) ?? null,
    },
    config: {
      billing_active: process.env.SLIMCAST_BILLING_ACTIVE === 'true',
      bridge_auth: process.env.SLIMCAST_BRIDGE_AUTH === 'true',
      alert_webhook: !!process.env.SLIMCAST_ALERT_WEBHOOK,
      // A :latest relay image is a known footgun (stale GHCR CDN pin) — surface it.
      relay_image_pinned: !!relayImage && !relayImage.endsWith(':latest'),
    },
    env_present: {
      supabase_service_role: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      stripe: !!process.env.STRIPE_SECRET_KEY,
      stream_key_secret: !!process.env.STREAM_KEY_SECRET,
      vast: !!process.env.VAST_API_KEY,
      hetzner: !!process.env.HETZNER_API_TOKEN,
    },
  })
}
