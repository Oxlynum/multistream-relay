-- Add auto-refill and Stripe payment method fields to profiles.
alter table public.profiles
  add column if not exists stripe_customer_id        text,
  add column if not exists stripe_payment_method_id  text,
  add column if not exists auto_refill_enabled       boolean not null default false,
  add column if not exists auto_refill_hours         integer not null default 10;
