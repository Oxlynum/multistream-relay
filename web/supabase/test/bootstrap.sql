-- Minimal Supabase-compatible bootstrap so the real migrations apply on a vanilla postgres:17
-- (used by web-ci.yml's migration job and by local `docker run postgres:17` testing — see the
-- CLAUDE.md "Tests" note). Mirrors just enough of Supabase's managed setup: the anon/
-- authenticated/service_role roles, the auth schema stubs the schema FKs + RLS policies need,
-- and Supabase's default privileges (new public objects granted to the browser roles) — which
-- is the exact posture 20260701000002_deny_by_default revokes, so assert.sql proves the revoke.
create extension if not exists pgcrypto;

do $$ begin
  if not exists (select from pg_roles where rolname='anon')          then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role')  then create role service_role nologin bypassrls; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
