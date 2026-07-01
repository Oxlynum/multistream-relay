-- STREAM-02 Stage B: truthful YouTube liveness.
--
-- YouTube HLS ingest returns HTTP 200 even for a dead / unbound / revoked key, so the
-- hub's passthrough ffmpeg stays "running" and the dock dot reads GREEN while the
-- YouTube stream is actually dead (the enterprise-audit STREAM-02 "trigger incident").
-- Stage A's de-tee didn't touch this: YouTube was already its own runner; the lie is in
-- the liveness *signal*, not the fan-out. We poll the YouTube Data API server-side
-- (liveStreams.list -> status.healthStatus — the relay has no OAuth token, and this MUST
-- stay OFF the hub heartbeat loop per STREAM-04/REL-06) and cache a verdict here that
-- /api/gpu/status overlays onto the youtube dot. Mirrors the twitch-eligibility caching
-- pattern (server-probed; the *_checked_at column drives the re-poll cadence).
--
-- youtube_health (the verdict the overlay reads): 'live' | 'dead' | 'pending' | null
--   null    = never checked
--   pending = ONE dead reading seen, not yet confirmed — dot stays as the relay reports
--             it, so a stream still warming up at go-live never flashes a false error
--   live    = receiving data (healthStatus good / ok / bad)
--   dead    = confirmed noData / revoked across >=2 consecutive reads -> dot -> 'error'
-- youtube_health_checked_at drives the adaptive poll cadence (tight until 'live', then
-- sparse) AND the concurrent-refresh (thundering-herd) claim guard in lib/youtube-health.
--
-- Writable ONLY by service-role: platform_connections carries a table-wide client UPDATE
-- revoke (20260630000001 SEC-02), so these columns inherit that lockdown automatically.
-- Additive + idempotent (add column if not exists) + convergent.
alter table public.platform_connections
  add column if not exists youtube_health text,
  add column if not exists youtube_health_checked_at timestamptz;
