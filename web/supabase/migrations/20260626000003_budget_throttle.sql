-- Dynamic budget throttling: live cost telemetry + throttle state on gpu_instances.
--
-- The pod measures real bandwidth from /proc/net/dev each heartbeat and computes
-- its true infrastructure cost ($/hr = GPU rate + egress + ingress). It reports
-- that here so the dashboard/dock can show real spend, and it reports the OBS
-- source bitrate it wants the plugin to apply (the one lever that cuts both
-- ingress and YouTube passthrough egress).
--
-- NOTE: these track SlimCast's *Vast cost*, not the user's bill. The user is
-- billed by burn_rate (platform count + add-ons) regardless of throttling; this
-- loop only protects the margin between flat user revenue and variable Vast cost.
alter table gpu_instances
  -- Live measured infrastructure cost, refreshed every heartbeat (~10s).
  add column if not exists cost_usd_hr     numeric,
  add column if not exists egress_gb_hr    numeric,
  add column if not exists ingress_gb_hr   numeric,
  -- The OBS source bitrate the pod's controller wants. Surfaced to the plugin via
  -- /api/gpu/status; the plugin applies it to the live encoder. NULL = no throttle.
  add column if not exists suggested_ingest_kbps integer,
  -- Current quality-ladder tier the controller has settled on (0 = full quality).
  -- Drives the dock's "quality auto-adjusted" banner and effective-resolution billing.
  add column if not exists throttle_tier   integer not null default 0;
