-- Phase 3 (vps-hub-plan §7): two-tier billing.
--   • PAYG (default): meter everything against a purchased token balance
--     (profiles.streaming_credits). Passthrough 0.1 tok/hr, transcode 1.0 + adders.
--   • SUBSCRIPTION ($20/mo): a monthly token allotment (rolls over, capped) PLUS the
--     purchased balance. Passthrough 0.05 tok/hr (cheaper, but never free — a 24/7 idle
--     passthrough still burns our VPS bandwidth). Transcode 1.0 + adders.
--
-- Spendable pool = allotment_tokens + streaming_credits. Spend order: allotment first,
-- then purchased (deduct_tokens). Kill-on-empty is uniform across plans.
-- All additive; inert until SLIMCAST_BILLING_ACTIVE=true.

-- ── profiles: plan + subscription state + rolling allotment ───────────────────
alter table public.profiles
  add column if not exists plan text not null default 'payg',
  add column if not exists subscription_status text,
  add column if not exists subscription_current_period_end timestamptz,
  add column if not exists subscription_price_id text,
  -- Subscription monthly allotment, rolling + capped. Spent before purchased credits.
  add column if not exists allotment_tokens numeric(12,6) not null default 0,
  add column if not exists allotment_refreshed_at timestamptz;

-- BALANCE PRECISION: bump the accumulating balance columns to 6 decimals. At the 10s
-- heartbeat cadence, passthrough burns 0.05–0.1 tok/hr → ~0.0001–0.0003 tok/beat. At the
-- old numeric(10,3) granularity that rounds to 0.000 and the charge vanishes (passthrough
-- would be effectively free — violating the model + leaking revenue). 6dp lets each tiny
-- per-beat deduction persist and accumulate. Display still rounds via formatTokens().
alter table public.profiles
  alter column streaming_credits type numeric(12,6);
alter table public.stream_sessions
  alter column credits_deducted type numeric(12,6);

-- plan check (drop-then-add so re-runs don't fail on a pre-existing constraint).
alter table public.profiles drop constraint if exists profiles_plan_check;
alter table public.profiles
  add constraint profiles_plan_check check (plan in ('payg', 'subscription'));

-- ── stream_sessions: which model billed this session (telemetry/audit) ────────
alter table public.stream_sessions
  add column if not exists billed_model text;

-- ── credited_invoices: idempotency ledger for monthly allotment grants ────────
-- Mirrors credited_payments, keyed by the Stripe INVOICE id so a webhook retry (or
-- invoice.paid firing twice) can never double-grant the monthly allotment.
create table if not exists public.credited_invoices (
  invoice_id     text primary key,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  tokens_granted numeric(10,3) not null,
  created_at     timestamptz not null default now()
);
alter table public.credited_invoices enable row level security;
-- Service-role only (no browser access) — RLS on with no policies = deny all to anon/auth.

-- ── deduct_tokens: atomic allotment-first deduction ───────────────────────────
-- Decrements the allotment first, then the purchased balance, under a FOR UPDATE row
-- lock so concurrent heartbeats (pod + hub) can't race a double-spend. Clamps both at
-- 0 (never negative). Returns the new total spendable (allotment + purchased), or NULL
-- if the user row is missing.
create or replace function public.deduct_tokens(
  p_user_id uuid,
  p_amount  numeric
) returns numeric
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_allot      numeric;
  v_purchased  numeric;
  v_from_allot numeric;
  v_amount     numeric;
  v_total      numeric;
begin
  select coalesce(allotment_tokens, 0), coalesce(streaming_credits, 0)
    into v_allot, v_purchased
    from public.profiles
    where id = p_user_id
    for update;
  if not found then
    return null;
  end if;

  v_amount := greatest(p_amount, 0);
  v_from_allot := least(v_allot, v_amount);

  update public.profiles
    set allotment_tokens = greatest(0, v_allot - v_from_allot),
        streaming_credits = greatest(0, v_purchased - (v_amount - v_from_allot))
    where id = p_user_id
    returning (coalesce(allotment_tokens, 0) + coalesce(streaming_credits, 0)) into v_total;

  return v_total;
end;
$$;

grant all on function public.deduct_tokens(uuid, numeric) to service_role;

-- ── grant_subscription_allotment: idempotent monthly grant, rollover-capped ────
-- Adds the plan's monthly token allotment, capped at p_cap (rollover ceiling), exactly
-- once per Stripe invoice id. Returns true if granted now, false if already granted.
create or replace function public.grant_subscription_allotment(
  p_invoice_id text,
  p_user_id    uuid,
  p_tokens     numeric,
  p_cap        numeric
) returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.credited_invoices (invoice_id, user_id, tokens_granted)
  values (p_invoice_id, p_user_id, p_tokens);

  update public.profiles
    set allotment_tokens = least(p_cap, coalesce(allotment_tokens, 0) + p_tokens),
        allotment_refreshed_at = now()
    where id = p_user_id;

  return true;
exception when unique_violation then
  return false;
end;
$$;

grant all on function public.grant_subscription_allotment(text, uuid, numeric, numeric) to service_role;
