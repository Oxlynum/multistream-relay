-- Lease-scan + tenant-count indexes (enterprise-audit SCALE-04).
--
-- The universal-lease machinery has two hot read patterns that currently full-scan:
--   1. hub_active_tenant_count(hub_id): count gpu_instances WHERE vps_hub_id = $1
--      AND renew_deadline > now(). Called per-attach AND per-hub on every sweep — at
--      hundreds of concurrent sessions this runs ~1000×/sec against a seq scan.
--   2. sweepExpiredLeases(): walks gpu_instances (status<>'stopped'), vps_hubs
--      (status<>'ended'), relay_nodes (role='gpu_backend') by renew_deadline.
--
-- These composite/partial indexes serve both, and set up the Phase-1 sweep redesign
-- (which will query `WHERE renew_deadline < now()-grace` directly instead of scanning).
-- Pure additive DDL; CREATE INDEX IF NOT EXISTS is idempotent + convergent. (Not run
-- CONCURRENTLY so it stays inside the migration transaction — these tables are small.)

-- Serves hub_active_tenant_count's (vps_hub_id, renew_deadline) predicate directly
-- (supersedes the single-column gpu_instances_vps_hub_idx for that query).
create index if not exists gpu_instances_hub_renew_idx
  on public.gpu_instances (vps_hub_id, renew_deadline);

-- Serves the gpu_instances lease sweep / lease scans (live rows only).
create index if not exists gpu_instances_renew_idx
  on public.gpu_instances (renew_deadline)
  where status <> 'stopped';

-- Serves the vps_hubs lease sweep (non-ended hubs only).
create index if not exists vps_hubs_renew_idx
  on public.vps_hubs (renew_deadline)
  where status <> 'ended';

-- Serves the gpu_backend relay_nodes lease sweep.
create index if not exists relay_nodes_renew_idx
  on public.relay_nodes (renew_deadline)
  where role = 'gpu_backend';
