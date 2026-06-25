-- SRT uplink mode (optional premium feature).
--
-- When enabled, the broker provisions a UDP-capable host (Vast datacenter only)
-- and OBS pushes SRT to the pod instead of RTMP; the pod still tees RTMP out to
-- every platform. SRT rides UDP with its own loss recovery, so it's far more
-- resilient on weak/unstable uplinks — the core of SlimCast's low-upload audience.
-- Billed at +0.1 token/hr (see lib/billing.ts).

alter table profiles
  add column if not exists srt_enabled boolean not null default false;

-- The pod's host-mapped SRT ingest port (8890/udp). Null on RTMP pods.
alter table gpu_instances
  add column if not exists srt_port integer;
