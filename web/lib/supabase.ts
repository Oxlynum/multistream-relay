import { createBrowserClient as ssrBrowserClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'

export type Tier = 'free' | 'pro'

export interface TierLimits {
  tier: Tier
  max_outputs: number | null  // null = unlimited
  max_resolution: number | null  // null = unlimited, otherwise max height (e.g. 720)
}

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: { tier: 'free', max_outputs: 2, max_resolution: 720 },
  pro:  { tier: 'pro',  max_outputs: null, max_resolution: null },
}

// Server client for API routes — uses service role key, bypasses RLS.
//
// Hoisted to a module/globalThis singleton (enterprise-audit SCALE-06). createClient()
// rebuilds the whole PostgREST + fetch/auth scaffolding on each call, and this is invoked
// on every heartbeat + dock/dashboard poll (43 call sites). The service client carries NO
// per-request state — a static service-role key and no user session (every server-side
// auth.getUser() call passes the JWT explicitly, so it's a stateless verify that never
// mutates the client's session) — so ONE shared instance is safe and lets Vercel Fluid's
// warm instance reuse the fetch agent across concurrent invocations instead of churning a
// new client + TLS agent per request. globalThis-guarded so dev HMR / module re-eval can't
// spawn duplicates.
//
// The type is captured from a factory (ReturnType<typeof makeServerClient>) rather than
// annotated as ReturnType<typeof createClient>: the latter instantiates createClient's
// generic with its DEFAULT Database param, which collapses every `.from(t).select()` row to
// `never` at all 43 call sites. Inferring from the factory preserves the exact query-builder
// type the un-annotated function returned before, so callers are byte-identical.
function makeServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}
const _serverClientHolder = globalThis as unknown as {
  __slimcastServerClient?: ReturnType<typeof makeServerClient>
}

export function createServerClient() {
  if (!_serverClientHolder.__slimcastServerClient) {
    _serverClientHolder.__slimcastServerClient = makeServerClient()
  }
  return _serverClientHolder.__slimcastServerClient
}

// Browser client — uses @supabase/ssr so session is stored in cookies (readable by middleware).
let _browserClient: ReturnType<typeof ssrBrowserClient> | null = null

export function createBrowserClient() {
  if (!_browserClient) {
    _browserClient = ssrBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    )
  }
  return _browserClient
}
