-- Live burn rate (tokens/hr) for the running stream, written by the pod agent's
-- heartbeat so the dashboard + OBS dock can show a real-time cost meter without
-- recomputing it client-side.
alter table public.gpu_instances
  add column if not exists burn_rate real not null default 0;
