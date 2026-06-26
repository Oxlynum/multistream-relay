-- Per-heartbeat connection quality metrics.
-- Written by /api/agent/status on every pod heartbeat (every ~10s while streaming):
--   direction='inbound'  → OBS→pod link health
--   direction='outbound' → pod→platform link health (one row per active platform)
-- Read by /api/metrics/connection to power the health graph in the dashboard + OBS dock.
create table if not exists public.connection_metrics (
  id            bigint generated always as identity primary key,
  instance_id   uuid        not null,
  user_id       uuid        not null references public.profiles(id) on delete cascade,
  direction     text        not null check (direction in ('inbound', 'outbound')),
  platform      text,                         -- null for inbound; 'twitch'/'kick'/etc for outbound
  bitrate_kbps  integer,
  health_score  integer     not null default 0,
  dropped_frames integer    not null default 0,
  recorded_at   timestamptz not null default now()
);

-- Index for the common query pattern: user + direction + time window (+ platform for outbound).
create index if not exists connection_metrics_user_dir_ts
  on public.connection_metrics (user_id, direction, recorded_at desc);

-- Retention: auto-delete rows older than 24h (avoids unbounded table growth).
-- The dashboard only queries a 2h window; 24h is generous headroom for debugging.
create or replace function public.prune_old_connection_metrics()
returns void language sql as $$
  delete from public.connection_metrics
  where recorded_at < now() - interval '24 hours';
$$;

-- Row-level security: users can only read their own rows.
alter table public.connection_metrics enable row level security;

create policy "Users can read own connection_metrics"
  on public.connection_metrics for select
  using (auth.uid() = user_id);

-- Service-role inserts bypass RLS (the status route uses the service role key).
