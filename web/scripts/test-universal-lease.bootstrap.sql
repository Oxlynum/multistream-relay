-- Minimal pre-migration schema for testing 20260628000009_universal_lease.sql on a
-- throwaway Postgres (per CLAUDE.md). Represents the three billable tables in their
-- PRE-migration shape (vps_hubs still has session_count; no renew_deadline anywhere)
-- so the migration's ALTER/DROP/CREATE-OR-REPLACE all exercise against real columns.
--
-- Run: docker run -d --name pgt -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17
--      cat bootstrap.sql <migration>.sql assert.sql | docker exec -i pgt psql -v ON_ERROR_STOP=1 -U postgres -d postgres

-- Roles the migration GRANTs to (vanilla PG lacks them).
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;

create table public.gpu_instances (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null unique,
  status         text not null default 'provisioning',
  vps_hub_id     uuid,
  max_session_at timestamptz
);

create table public.relay_nodes (
  id          uuid primary key default gen_random_uuid(),
  instance_id uuid not null,
  role        text not null,
  status      text
);

create table public.vps_hubs (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null default 'hetzner',
  provider_id   text,
  primary_ip_id text,
  region        text not null,
  status        text not null default 'spawning',
  max_sessions  int  not null default 10,
  session_count int  not null default 0,
  hub_key_hash  text,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  empty_since   timestamptz
);
