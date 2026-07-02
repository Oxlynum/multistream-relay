-- Stripe event-level idempotency ledger (fableroadmap Phase D pre-billing hardening).
-- Defense-in-depth ON TOP of the existing per-payment (credited_payments) and per-invoice
-- (credited_invoices) guards: records each Stripe event id exactly once so the webhook can skip
-- a redelivered event before re-running its side effects. The money paths are already idempotent
-- (creditPaymentOnce / grantSubscriptionAllotment), so this is belt-and-suspenders for the whole
-- event, incl. the non-money profile writes. Recorded only AFTER successful processing, so a
-- transiently-failed event (which returns 500) is still reprocessed on Stripe's retry.
-- Additive + idempotent.
create table if not exists public.stripe_events (
  event_id   text primary key,
  type       text,
  created_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;
-- Strictly service-role only. RLS-on with no policy already denies browser row access, but this
-- table should NEVER be browser-readable, so we also revoke the SELECT grant outright (belt-and-
-- suspenders: even a future accidental policy can't expose it). service_role bypasses RLS + keeps
-- its own grant. The webhook (service role) is the sole reader/writer.
revoke all on public.stripe_events from anon, authenticated;
