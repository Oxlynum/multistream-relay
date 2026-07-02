-- Billing correctness: idempotent metered deduction + usage ledger (fableroadmap M5 + M6).
--
-- M5 (idempotency). Today the hub Clock A reads last_seen_at, calls deduct_tokens, then a
-- SEPARATE update advances last_seen_at. Those steps aren't atomic and share no CAS, so two
-- overlapping/retried hub beats (Vercel at-least-once delivery, a post-timeout retry, or a
-- last_seen_at write that failed after the deduct committed) both read the same anchor and
-- deduct the SAME interval twice → double charge. Fix: a dedicated billing cursor
-- `last_billed_at`, advanced by a compare-and-swap INSIDE one transaction with the deduction.
-- Exactly one beat can advance the cursor across a given interval; a losing (duplicate) beat
-- charges nothing.
--
-- M6 (ledger). Money currently leaves with no per-deduction record: stream_sessions.credits_
-- deducted is never written (so /api/stats always reports $0 spend) and there is no dispute or
-- reconciliation trail. Fix: an immutable usage_events row per charged interval, plus a running
-- stream_sessions.credits_deducted total and the billed plan.
--
-- All additive; inert until SLIMCAST_BILLING_ACTIVE=true (the clock only calls the RPC when
-- billing is on). Idempotent + convergent (IF NOT EXISTS / CREATE OR REPLACE / drop-then-create
-- policy), safe on a live schema and a fresh-history replay.

-- ── billing cursor (distinct from the last_seen_at liveness timestamp) ─────────────────
alter table public.gpu_instances
  add column if not exists last_billed_at timestamptz;

-- ── usage_events: immutable per-interval charge ledger (M6) ────────────────────────────
create table if not exists public.usage_events (
  id             uuid primary key default gen_random_uuid(),
  instance_id    uuid not null,                 -- gpu_instances.id (the tenant session)
  user_id        uuid not null references public.profiles(id) on delete cascade,
  session_id     uuid,                          -- stream_sessions.id (nullable)
  period_start   timestamptz not null,
  period_end     timestamptz not null,
  seconds        numeric(12,3) not null,
  tokens_charged numeric(12,6) not null,
  burn_rate      numeric(12,6) not null,
  billed_model   text,
  created_at     timestamptz not null default now(),
  -- Idempotency backstop: one ledger row per (tenant, interval start). The CAS in the RPC is the
  -- primary guard; this makes a double-insert impossible even if a caller passes a stale anchor.
  unique (instance_id, period_start)
);
create index if not exists usage_events_user_created_idx on public.usage_events (user_id, created_at desc);
create index if not exists usage_events_session_idx on public.usage_events (session_id);

alter table public.usage_events enable row level security;
-- Owner may READ its own usage (dashboard "lifetime spend" / history). Writes are service-role
-- only — the deny-by-default lockdown (20260701000002) already strips browser INSERT/UPDATE/
-- DELETE on every table; this SELECT policy is what lets the owner read its own rows under RLS.
drop policy if exists "usage_events owner read" on public.usage_events;
create policy "usage_events owner read" on public.usage_events
  for select using (auth.uid() = user_id);

-- ── bill_stream_interval: idempotent, atomic meter for ONE interval (M5 + M6) ──────────
-- In ONE transaction: (1) CAS-advance the billing cursor from p_prev_billed_at → p_period_end;
-- a losing (duplicate/overlapping) beat matches 0 rows and returns charged=false, deducting
-- NOTHING. (2) The winner appends the usage_events ledger row, deducts p_tokens allotment-first
-- (reusing the tested deduct_tokens), and accrues the running stream_sessions total. Returns the
-- post-deduction spendable so the caller can apply kill-on-empty. NULL-safe first bill (cursor
-- starts NULL). gpu_instances is locked (CAS) before profiles (deduct_tokens) — a consistent
-- lock order across every beat, so no deadlock.
create or replace function public.bill_stream_interval(
  p_instance_id    uuid,
  p_user_id        uuid,
  p_session_id     uuid,
  p_prev_billed_at timestamptz,
  p_period_start   timestamptz,
  p_period_end     timestamptz,
  p_seconds        numeric,
  p_tokens         numeric,
  p_burn_rate      numeric,
  p_billed_model   text
) returns table (out_charged boolean, out_spendable numeric)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_won       integer;
  v_spendable numeric;
begin
  -- (1) Idempotency CAS — only one beat advances the cursor across this interval.
  update public.gpu_instances
     set last_billed_at = p_period_end
   where id = p_instance_id
     and last_billed_at is not distinct from p_prev_billed_at;
  get diagnostics v_won = row_count;

  if v_won = 0 then
    -- A concurrent/retried beat already billed this interval → charge nothing.
    select coalesce(allotment_tokens, 0) + coalesce(streaming_credits, 0)
      into v_spendable from public.profiles where id = p_user_id;
    return query select false, coalesce(v_spendable, 0);
    return;
  end if;

  -- (2a) Immutable ledger row (M6). Won the CAS, so this is the sole writer for this interval.
  insert into public.usage_events(
    instance_id, user_id, session_id, period_start, period_end, seconds, tokens_charged, burn_rate, billed_model)
  values (
    p_instance_id, p_user_id, p_session_id, p_period_start, p_period_end,
    greatest(p_seconds, 0), greatest(p_tokens, 0), greatest(p_burn_rate, 0), p_billed_model)
  on conflict (instance_id, period_start) do nothing;

  -- (2b) Deduct allotment-first (reuse the tested deduction), then accrue the session total.
  v_spendable := public.deduct_tokens(p_user_id, greatest(p_tokens, 0));
  if p_session_id is not null then
    update public.stream_sessions
       set credits_deducted = coalesce(credits_deducted, 0) + greatest(p_tokens, 0),
           billed_model = coalesce(p_billed_model, billed_model)
     where id = p_session_id;
  end if;

  return query select true, coalesce(v_spendable, 0);
end;
$$;

-- Server-only (matches the deny-by-default posture; explicit for auditability).
revoke all on function public.bill_stream_interval(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, numeric, numeric, numeric, text) from public, anon, authenticated;
grant execute on function public.bill_stream_interval(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, numeric, numeric, numeric, text) to service_role;
