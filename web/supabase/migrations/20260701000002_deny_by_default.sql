-- Deny-by-default lockdown of schema public (fableroadmap Phase A, item 1).
-- Closes: C1 (credit mint via grant_subscription_allotment), H1 (deduct_tokens
-- balance drain / zeroing), H3 (INSERT/DELETE forge on platform_connections &
-- gpu_instances), M1 (rate_limit_hit limiter poisoning). Highest-leverage fix in
-- the whole audit.
--
-- ROOT CAUSE. PostgreSQL grants EXECUTE on every new function to PUBLIC by default,
-- and Supabase grants the anon/authenticated roles table-wide DML by default. The
-- prior lockdown (20260630000001_rls_lockdown) revoked UPDATE on four tables but
-- left two holes wide open:
--   (a) every SECURITY DEFINER RPC stayed world-executable — so any logged-in
--       browser (or the anon key) can, from devtools:
--         supabase.rpc('grant_subscription_allotment',
--           { p_invoice_id: crypto.randomUUID(), p_user_id: ME, p_tokens: 1e9, p_cap: 1e9 })
--       → unlimited allotment = unlimited free streaming (real GPU cost), and the
--       same for deduct_tokens (drain/zero any balance) and rate_limit_hit (trip a
--       victim's limiter → 429 lockout, live today);
--   (b) INSERT/DELETE stayed open on the sensitive tables — delete-then-reinsert the
--       platform_connections row with twitch_hevc_eligible:true routes to passthrough
--       billing (0.05-0.1 tok/hr) instead of transcode (1.0) — a ~10-20x undercharge —
--       or plant a gpu_instances row with a far-future lease the sweeper never reaps.
--
-- THE FIX — industry-standard deny-by-default. Revoke ALL execute/write from the
-- browser-facing roles across the entire public schema, re-grant to the server
-- (service_role) which is the ONLY caller of every RPC and every write, and set
-- DEFAULT PRIVILEGES so this class of hole cannot reopen when a future migration adds
-- a function or table.
--
-- VERIFIED SAFE — breaks NO real code path (checked against the whole web/ tree):
--   * All 15 .rpc() call sites are server modules on the service-role client
--     (app/api/*, lib/*). ZERO browser RPCs.
--   * All table writes (.insert/.update/.delete/.upsert) are in server files. ZERO
--     'use client' writers.
--   * No RLS policy calls a public.* function (policies use auth.uid() / table refs),
--     so revoking function EXECUTE cannot break policy evaluation.
--   * SELECT is deliberately left intact, so RLS-scoped dashboard reads keep working.
--   * Trigger functions (handle_new_user) fire regardless of EXECUTE grants and are
--     SECURITY DEFINER, so signup is unaffected.
--
-- Idempotent + convergent: revoke/grant/alter-default are no-ops when already applied,
-- so this is safe to re-run and safe on both a live schema and a fresh-history replay.
-- Objects created by LATER migrations are covered by the ALTER DEFAULT PRIVILEGES below.
--
-- If a FUTURE feature legitimately needs a browser-callable RPC or a direct client
-- write, add a NARROW explicit grant in a later migration
-- (e.g. `grant execute on function public.<fn>(...) to authenticated;`) — never
-- re-open the whole schema.

-- ── Functions: execute is server-only ─────────────────────────────────────────────
-- Existing functions (deduct_tokens, grant_subscription_allotment, rate_limit_hit,
-- attach_session_to_hub, detach_from_hub, handle_new_user, prune_old_connection_metrics,
-- hub_egress_ceiling_gb_hr, credit_payment_once, and every other public fn).
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;
-- Future functions: deny the browser roles, keep the server role.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public grant  execute on functions to service_role;

-- ── Tables: writes are server-only; SELECT/RLS reads untouched ─────────────────────
-- Closes H3 (platform_connections, gpu_instances) and generalizes the same least-
-- privilege posture to every server-owned table (profiles, stream_sessions,
-- relay_nodes, vps_hubs, connection_metrics, achievements, device_link_codes, …).
-- anon/authenticated keep SELECT (RLS-scoped); every write already flows through a
-- service-role /api route, and service_role's own DML grants are left intact.
revoke insert, update, delete on all tables in schema public from anon, authenticated;
-- Future tables inherit the same posture (write-denied for the browser roles). SELECT
-- is left to Supabase's default grant so new dashboard reads keep working under RLS.
alter default privileges in schema public revoke insert, update, delete on tables from anon, authenticated;

-- ── Secret-bearing, server-only tables: deny browser SELECT entirely (M22) ─────────
-- gpu_instances / relay_nodes / vps_hubs hold per-session secrets — bridge_secret,
-- srt_passphrase, ingest_key, node/hub key hashes — that must NEVER leave the server. Their
-- owner-read RLS policy is column-BLIND, so today the owner's own browser can read those
-- secrets. VERIFIED these three tables are read ONLY by server (service-role) code: the dock
-- and dashboard get live status through /api/gpu/status, never a direct browser select. So
-- revoke the browser SELECT outright (service_role bypasses RLS and keeps its own SELECT).
-- This is the clean, low-risk half of M22; the MediaMTX publish-auth / :1935-loopback half is
-- a relay-side change deferred to a later phase (it touches the freshly-proven hub pipeline).
revoke select on public.gpu_instances, public.relay_nodes, public.vps_hubs from anon, authenticated;
