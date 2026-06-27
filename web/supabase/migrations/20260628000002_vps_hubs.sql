-- VPS-as-the-Hub Phase 1 (S1): shared multi-tenant hub data model.
-- Additive only; inert until SLIMCAST_VPS_HUB flips on. Prod all-in-one rows have
-- vps_hub_id IS NULL → unchanged path.
--
-- WHY a new table (not relay_nodes): relay_nodes (Phase 0) is per-session
-- (instance_id → gpu_instances CASCADE, UNIQUE(instance_id, role)) = ONE box per
-- session. A multi-tenant hub is the inverse: ONE box, N sessions. So the shared
-- hub gets its own top-level table with a refcount, and relay_nodes stays reserved
-- for the Phase-2 per-session GPU backend.
--
-- Deploy with: supabase db push

-- ── vps_hubs: one row per shared physical VPS box ────────────────────────────
create table if not exists public.vps_hubs (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,                          -- 'hetzner'
  provider_id   text,                                   -- provider server id (CreatedVps.vpsId)
  primary_ip_id text,                                   -- Hetzner primary IPv4 resource id;
                                                        -- persist SYNC after create() — leak guard
  ip_address    text,                                   -- public IPv4 (CreatedVps.ip)
  region        text not null,                          -- 'ash'|'hil'|'fsn1'|'nbg1'|'hel1'|'sin'
  lat           numeric,
  lon           numeric,
  server_type   text,                                   -- 'cx23' etc (live catalog, never hardcoded)
  status        text not null default 'spawning',       -- 'spawning'|'live'|'draining'|'ended'
  max_sessions  int  not null default 10,               -- per-server-type capacity (load-test §10.4)
  session_count int  not null default 0,                -- active attached streams (refcount → scale-to-zero)
  hub_key_hash  text,                                   -- sha256 of the box's 'vps' agent key
  -- telemetry (billing deactivated; harmless to record)
  cost_usd_hr   numeric,
  egress_gb_hr  numeric,
  ingress_gb_hr numeric,
  last_seen_at  timestamptz,                            -- hub heartbeat freshness (Clock B staleness)
  created_at    timestamptz not null default now()
);

create index if not exists vps_hubs_region_status_idx on public.vps_hubs (region, status);
create index if not exists vps_hubs_provider_idx       on public.vps_hubs (provider, provider_id);

-- Spawn lock: at most ONE hub may be in 'spawning' per region at a time. Two
-- concurrent first-users in an empty region → the loser hits this unique violation
-- and polls-and-attaches instead of spawning a duplicate box (Hetzner bills hourly,
-- so a duplicate is real waste).
create unique index if not exists vps_hubs_one_spawning_per_region
  on public.vps_hubs (region) where status = 'spawning';

-- Service-role only (broker/agent routes use the service key, which bypasses RLS).
-- No user_id on this table → no owner-read policy needed; enabling RLS with no
-- policy denies all anon/authenticated access (correct: hubs are internal infra).
alter table public.vps_hubs enable row level security;

-- ── gpu_instances: link a session to its shared hub ──────────────────────────
-- gpu_instances stays the per-user session anchor (UNIQUE(user_id) unchanged); it
-- still holds the tenant's own ingest_key/srt_passphrase/max_session_at/idle_since.
-- vps_hub_id is the NEW shared-hub link. ON DELETE SET NULL so destroying a hub
-- doesn't cascade-delete tenant sessions (they get re-attached/re-spawned).
alter table public.gpu_instances
  add column if not exists vps_hub_id uuid references public.vps_hubs(id) on delete set null;

create index if not exists gpu_instances_vps_hub_idx on public.gpu_instances (vps_hub_id);

-- ── attach_session_to_hub: atomic, idempotent join ───────────────────────────
-- PostgREST can't express FOR UPDATE SKIP LOCKED, so the capacity-safe attach is a
-- Postgres function. Atomic (one txn) and idempotent:
--   * if the session already has a hub → return it, do NOT re-increment
--   * else pick the fullest live hub with spare capacity (best-fit bin packing so
--     boxes stay full and others can scale to zero), increment its refcount, link
--     the session, and return the hub
--   * if no hub has capacity → return NULL (caller spawns one)
create or replace function public.attach_session_to_hub(p_user_id uuid, p_region text)
returns public.vps_hubs
language plpgsql
as $$
declare
  v_hub      public.vps_hubs;
  v_existing uuid;
begin
  -- idempotency: a re-provision (rate-limited 5/60) or Vercel retry must not double-count
  select vps_hub_id into v_existing from public.gpu_instances where user_id = p_user_id;
  if v_existing is not null then
    select * into v_hub from public.vps_hubs where id = v_existing;
    return v_hub;   -- already attached
  end if;

  select * into v_hub
  from public.vps_hubs
  where region = p_region and status = 'live' and session_count < max_sessions
  order by session_count desc      -- fill fullest box first (bin packing)
  limit 1
  for update skip locked;

  if not found then
    return null;    -- caller spawns a hub
  end if;

  update public.vps_hubs   set session_count = session_count + 1 where id = v_hub.id
    returning * into v_hub;
  update public.gpu_instances set vps_hub_id = v_hub.id          where user_id = p_user_id;

  return v_hub;
end;
$$;

-- ── detach_from_hub: decrement a hub's refcount (floor 0) ─────────────────────
-- Called by Clock A (per-stream teardown). Plain decrement; teardown only calls it
-- once per session (it proceeds only when it actually found+removed the session row),
-- and the floor guards against any stray double-call.
create or replace function public.detach_from_hub(p_hub_id uuid)
returns void
language sql
as $$
  update public.vps_hubs
  set session_count = greatest(session_count - 1, 0)
  where id = p_hub_id;
$$;
