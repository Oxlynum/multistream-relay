-- Phase 3 pre-req (vps-hub-plan §2.3): reconcile the credit money-path drift.
--
-- GROUND TRUTH from a live `supabase db dump` (2026-06-28):
--   • LIVE profiles has `streaming_credits numeric(10,3) default 2.000` and does NOT
--     have `streaming_credits_seconds`. But the migration HISTORY (20260617000001)
--     adds `streaming_credits_seconds integer default 7200` and never creates
--     `streaming_credits`. So replaying history from scratch produces a schema that
--     does NOT match prod — the column was hand-migrated out-of-band.
--   • LIVE has TWO `credit_payment_once` overloads: `(…, p_seconds integer)` (writes the
--     now-nonexistent seconds column → dead/broken, never called) and `(…, p_tokens
--     numeric)` (writes streaming_credits → the one the code actually calls).
--   • `handle_new_user` inserts into the nonexistent `streaming_credits_seconds`; it only
--     "works" because its `exception when others` handler swallows the failure (new rows
--     then fall back to the column DEFAULT — fragile).
--
-- This migration is IDEMPOTENT and CONVERGENT: it lands on the same canonical schema
-- whether applied to LIVE (numeric column already present) or to a fresh replay of the
-- seconds-based history. Canonical form: ONE numeric token column `streaming_credits`,
-- ONE `credit_payment_once(p_tokens numeric)` function, a non-broken `handle_new_user`.

-- 1. Ensure the canonical numeric token column exists. (No-op on live.)
alter table public.profiles
  add column if not exists streaming_credits numeric(10,3) not null default 2.000;

-- 2. If the legacy seconds column still exists (fresh replay of history), migrate any
--    balances into tokens (seconds / 3600) and drop it. Skipped entirely on live, so it
--    can NEVER clobber a real numeric balance.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'streaming_credits_seconds'
  ) then
    update public.profiles
      set streaming_credits = round((coalesce(streaming_credits_seconds, 0)::numeric) / 3600.0, 3)
      where streaming_credits_seconds is not null;
    alter table public.profiles drop column streaming_credits_seconds;
  end if;
end $$;

-- 3. credited_payments: ensure the canonical token column exists and the legacy seconds
--    column is nullable (the new function only writes credits_tokens).
alter table public.credited_payments
  add column if not exists credits_tokens numeric(10,3);
alter table public.credited_payments
  alter column credits_seconds drop not null;

-- 4. Drop the dead integer/seconds overload (references the dropped column). The
--    `(p_tokens numeric)` overload below is the single canonical credit path.
drop function if exists public.credit_payment_once(text, uuid, integer);

create or replace function public.credit_payment_once(
  p_payment_id text,
  p_user_id    uuid,
  p_tokens     numeric
) returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.credited_payments (payment_id, user_id, credits_tokens)
  values (p_payment_id, p_user_id, p_tokens);

  update public.profiles
    set streaming_credits = coalesce(streaming_credits, 0) + p_tokens
    where id = p_user_id;

  return true;
exception when unique_violation then
  -- Already credited for this payment — idempotent no-op.
  return false;
end;
$$;

-- SECURITY: this is a SECURITY DEFINER function with NO internal auth check — p_user_id
-- and p_tokens are caller-supplied. It must NOT be reachable from a browser JWT via
-- PostgREST RPC (that would let any user self-mint unlimited credits). The only caller
-- (lib/billing.ts) runs as service_role. Postgres grants EXECUTE to PUBLIC by default at
-- CREATE, so an explicit REVOKE is required — dropping the grant line alone is not enough.
-- (This also closes the pre-existing prod grant to anon/authenticated.)
revoke all on function public.credit_payment_once(text, uuid, numeric) from public, anon, authenticated;
grant execute on function public.credit_payment_once(text, uuid, numeric) to service_role;

-- 5. Fix handle_new_user: insert the canonical column (or rely on its DEFAULT). Free
--    trial = 2 tokens (= 2 hours at base) matching profiles.streaming_credits DEFAULT.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.profiles (id, email, tier, streaming_credits)
  values (new.id, new.email, 'free', 2.000);
  return new;
exception when others then
  raise log 'handle_new_user failed: % %', SQLSTATE, SQLERRM;
  return new;
end;
$$;
