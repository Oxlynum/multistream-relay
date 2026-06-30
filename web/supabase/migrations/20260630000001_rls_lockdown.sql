-- Server-authoritative money / lease / entitlement columns (enterprise-audit SEC-01, SEC-02).
--
-- The problem: Supabase grants the `authenticated` (and `anon`) roles table-wide
-- DML by default, and RLS `... for update using (auth.uid() = id)` policies with NO
-- column scope let any logged-in browser PATCH ANY column of its OWN row through
-- PostgREST — bypassing the entire server-side billing / Stripe / broker layer.
--
-- Concretely, today a logged-in user can run, from devtools:
--   supabase.from('profiles').update({ streaming_credits: 1e9, has_2k_addon: true,
--                                      plan: 'subscription', subscription_status: 'active' })
--   supabase.from('gpu_instances').update({ renew_deadline: '2099-01-01',
--                                           max_session_at: '2099-01-01', idle_since: null })
-- → self-minted credits + free 2K (real GPU cost: $1/hr ceiling vs $0.50, independent of
--   the billing flag) + subscriber pricing, and a lease far enough in the future that the
--   universal sweeper + 12h hard-cap never reap the box → unbounded GPU/hub spend.
--
-- The fix: REVOKE the client UPDATE privilege on these tables/columns. Every legitimate
-- write already goes through an /api route on the service-role client (which BYPASSES
-- RLS and these grants), so this breaks NO real code path — verified: there are ZERO
-- browser-client writes to profiles / gpu_instances / stream_sessions / the twitch_*
-- eligibility columns (dashboard pages only SELECT them). SELECT/read policies are
-- untouched, so the dashboard keeps working.
--
-- REVOKEs are idempotent + convergent (no-op if already revoked), so this migration is
-- safe to re-run and safe against a fresh-history replay.

-- ── profiles (SEC-01): credits / plan / subscription / 2K entitlement are server-only ──
-- All writes flow through /api/encode, /api/credits/auto-refill, and the Stripe webhook
-- (service-role). The client never writes profiles directly. Full UPDATE revoke is the
-- least-privilege fix; if a future UI feature needs a direct client write for a SAFE
-- column (e.g. portrait_zoom, bitrate sliders, primary_platform), add a column-scoped
-- GRANT (... TO authenticated) for ONLY that column in a later migration.
revoke update on public.profiles from authenticated, anon;

-- ── gpu_instances (SEC-02): lease / safety / billing telemetry are broker+heartbeat only ─
-- Written exclusively by the provision route, the /api/agent/* heartbeat handlers, the
-- broker, and the reaper — all service-role. Revoking client UPDATE closes lease
-- self-extension (renew_deadline / max_session_at / idle_since), status/streaming spoofing,
-- burn_rate tampering, and self-rotation of the ingest_key / bridge_secret / srt_passphrase
-- secrets. (000005 already revoked only vps_hub_id; this generalizes it to the whole table.)
revoke update on public.gpu_instances from authenticated, anon;

-- ── stream_sessions (SEC-02): the billing/usage audit trail is server-generated ──────
-- Sessions are created and closed server-side (provision + pod-teardown). Making
-- INSERT/UPDATE service-role-only stops a user from falsifying credits_deducted /
-- duration_seconds. Dashboard history reads (SELECT) are unaffected.
revoke insert, update on public.stream_sessions from authenticated, anon;

-- ── platform_connections (SEC-02): Twitch HEVC eligibility is server-probed, not claimed ─
-- twitch_hevc_eligible / twitch_use_passthrough / twitch_max_height gate the eRTMP
-- passthrough + 2K path (a cost/entitlement lever), set ONLY by the server-side Twitch
-- eligibility probe (lib/twitch-eligibility.ts). A COLUMN-level revoke would be INEFFECTIVE
-- here: Supabase grants TABLE-level UPDATE to authenticated, and a column REVOKE does not
-- override a table-level grant (has_column_privilege still returns true). So we revoke the
-- whole-table UPDATE. Verified safe: there are ZERO browser-client writes to
-- platform_connections — every write (key save, enable/disable, bitrate, orientation) goes
-- through /api/platforms + /api/output-settings (service-role). SELECT/reads are untouched.
revoke update on public.platform_connections from authenticated, anon;
