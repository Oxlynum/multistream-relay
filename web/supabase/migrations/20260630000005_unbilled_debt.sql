-- CORR-04: carry-forward billing debt (deduct_tokens fail-closed).
--
-- Before this, when deduct_tokens failed mid-stream, billStreamInterval discarded the charge
-- and re-read the full (un-decremented) balance every beat — so during a sustained RPC fault a
-- streaming user was billed nothing AND never hit the kill-on-empty (balance stayed positive):
-- silent free streaming for the whole fault. This column persists the unpaid charge on the
-- session so it ACCRUES across beats; the next successful deduct settles the whole accrued
-- amount, and the kill-on-empty trips once accrued debt reaches the balance.
--
-- Additive + idempotent. NOT NULL default 0 so every existing/new row starts debt-free. Inert
-- until SLIMCAST_BILLING_ACTIVE (billStreamInterval only accrues debt when billing is on).
alter table public.gpu_instances
  add column if not exists unbilled_debt numeric not null default 0;

comment on column public.gpu_instances.unbilled_debt is
  'CORR-04: tokens charged but not yet persisted (deduct_tokens failed) — carried across '
  'heartbeats, settled on the next successful deduct, and counted against kill-on-empty.';
