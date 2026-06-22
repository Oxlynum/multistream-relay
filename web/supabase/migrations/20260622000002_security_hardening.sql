-- Security hardening: idempotent credit grants, rate limiting, the 12h
-- "still streaming?" confirm clock, and a tighter agent_api_keys policy.

-- ── 1. Idempotent credit grants ──────────────────────────────────────────
-- Every paid credit grant is keyed by its Stripe payment id. Both the webhook
-- and the auto-refill path call credit_payment_once(); the PK + single
-- transaction guarantee a payment is credited exactly once, no matter how many
-- times Stripe retries the webhook or whether auto-refill already added it.
create table if not exists public.credited_payments (
  payment_id      text primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  credits_seconds integer not null,
  created_at      timestamptz not null default now()
);

alter table public.credited_payments enable row level security;
-- No policies: service-role only (the anon/auth client never touches this).

create or replace function public.credit_payment_once(
  p_payment_id text,
  p_user_id    uuid,
  p_seconds    integer
) returns boolean
language plpgsql
security definer
as $$
begin
  insert into public.credited_payments (payment_id, user_id, credits_seconds)
  values (p_payment_id, p_user_id, p_seconds);

  update public.profiles
    set streaming_credits_seconds = coalesce(streaming_credits_seconds, 0) + p_seconds
    where id = p_user_id;

  return true;
exception when unique_violation then
  -- Already credited for this payment — do nothing.
  return false;
end;
$$;

-- ── 2. Rate limiting (Supabase-backed fixed window) ──────────────────────
-- Cross-instance correct without a new vendor. rate_limit_hit() bumps a
-- per-key counter, resetting it when the window rolls over, and returns whether
-- the caller is still within the allowance.
create table if not exists public.rate_limits (
  key          text primary key,
  count        integer not null default 0,
  window_start timestamptz not null default now()
);

alter table public.rate_limits enable row level security;
-- No policies: service-role only.

create or replace function public.rate_limit_hit(
  p_key         text,
  p_max         integer,
  p_window_secs integer
) returns boolean
language plpgsql
security definer
as $$
declare
  cur public.rate_limits%rowtype;
begin
  insert into public.rate_limits (key, count, window_start)
  values (p_key, 1, now())
  on conflict (key) do update
    set count = case
          when public.rate_limits.window_start < now() - make_interval(secs => p_window_secs)
          then 1 else public.rate_limits.count + 1 end,
        window_start = case
          when public.rate_limits.window_start < now() - make_interval(secs => p_window_secs)
          then now() else public.rate_limits.window_start end
  returning * into cur;

  return cur.count <= p_max;
end;
$$;

-- ── 3. 12h "still streaming?" confirm clock ──────────────────────────────
-- The heartbeat warns the dock when within 30m of this, and hard-kills past it
-- unless the user confirms (which pushes it out another 12h).
alter table public.gpu_instances
  add column if not exists max_session_at timestamptz;

-- ── 4. Tighten agent_api_keys ────────────────────────────────────────────
-- The owner never needs to read key hashes from the browser; the dashboard
-- checks key existence through a server route (service role). Drop the client
-- SELECT policy so hashes are not exposed to the anon/auth client at all.
drop policy if exists "Users can read own api keys" on public.agent_api_keys;
