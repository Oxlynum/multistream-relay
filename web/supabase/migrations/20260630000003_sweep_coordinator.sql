-- Sweep coordinator: throttle the universal lease sweep + a control-plane recovery
-- gate (enterprise-audit SCALE-01 + CORR-01). PURELY ADDITIVE — one new table + one
-- new function; touches NO existing RPC, so it cannot regress lease/teardown behavior.
--
-- The problem (SCALE-01): sweepExpiredLeases() is fired via after() on EVERY heartbeat
-- from EVERY box (pod, hub, gpu-backend; ~1 beat / 10s / box). Each invocation scans the
-- whole fleet. At N concurrent boxes that is N sweeps every 10s, each O(N) → O(N²) DB load
-- per window, plus N concurrent after() functions holding Supabase pooler connections.
-- In the low hundreds of concurrent sessions this saturates a small/medium Postgres.
--
-- The problem (CORR-01): on a control-plane (Vercel) outage longer than the effective
-- box-dead threshold (BOX_LEASE_MS + SWEEP_GRACE_MS ≈ 210s), every relay's lease freezes
-- (no beat is processed to renew it). When Vercel recovers, the FIRST box to re-beat fires
-- a sweep that sees the ENTIRE fleet as lease-expired and mass-false-reaps healthy streams
-- before the heartbeat herd can re-renew.
--
-- The fix (one row, one atomic CAS): try_begin_sweep() is called at the top of every
-- sweep. A single-statement UPDATE …WHERE…RETURNING does all three jobs atomically:
--   1. THROTTLE — only the first caller after each p_throttle_ms window matches the WHERE
--      and gets a row back (should_sweep=true); all other concurrent beats match nothing
--      and skip. Sweep frequency becomes ~1 / throttle window, INDEPENDENT of fleet size
--      (O(N²) → O(1) sweeps/window). Non-winning beats do a single cheap row-lock probe
--      that writes nothing (no MVCC bloat); the ~1 winner/window writes one tuple.
--   2. OUTAGE DETECT — last_beat_at only advances on a WINNING sweep (~1 / window), so in
--      steady state the gap is ≈ the throttle window. A gap > p_outage_ms means no winning
--      sweep ran for that long ⇒ the control plane was down (or the fleet was idle). The
--      winner stamps reap_frozen_until = now() + p_recovery_ms.
--   3. RECOVERY FREEZE — should the freeze be active, the same atomic call returns
--      reap_frozen=true and the sweep skips all reaping this cycle, giving the recovering
--      heartbeat herd p_recovery_ms to re-renew every lease before reaping resumes. Because
--      the freeze is set and read in ONE statement under the row lock, no concurrent beat
--      can slip a reap through during recovery (the others are throttled out).
-- A spurious freeze during a genuinely-idle period (no boxes → no beats → large gap) is
-- harmless: there is nothing healthy to protect, and any real orphan waits one extra
-- recovery grace before the next sweep reaps it (the daily cron is the floor regardless).

create table if not exists public.sweep_coordinator (
  -- Singleton: the CHECK pins id=true so there is exactly one coordinator row.
  id                boolean primary key default true,
  last_sweep_at     timestamptz not null default now(),  -- last WINNING sweep (throttle anchor)
  last_beat_at      timestamptz not null default now(),  -- advanced only by a winning sweep (outage anchor)
  reap_frozen_until timestamptz not null default now(),  -- reaping suppressed while > now()
  constraint sweep_coordinator_singleton check (id)
);

-- Seed the single row (no-op on re-run / fresh-history replay → idempotent + convergent).
insert into public.sweep_coordinator (id) values (true) on conflict (id) do nothing;

-- Atomic throttle + outage-detect + recovery-freeze gate. SECURITY DEFINER + locked to
-- service_role (mirrors the 000009/000010 lease RPCs); the status route calls it on the
-- service-role client. Returns ONE row {should_sweep, reap_frozen} when this caller wins
-- the throttle window, or ZERO rows when throttled out (caller skips the sweep).
create or replace function public.try_begin_sweep(
  p_throttle_ms integer,
  p_outage_ms   integer,
  p_recovery_ms integer
)
returns table(should_sweep boolean, reap_frozen boolean)
language sql
security definer
set search_path = public
as $$
  update public.sweep_coordinator c
  set
    -- A gap in winning sweeps longer than the outage window ⇒ control plane was down:
    -- freeze reaping until the recovering herd re-renews. Otherwise keep any active freeze.
    reap_frozen_until = case
      when now() - c.last_beat_at > (p_outage_ms::text || ' milliseconds')::interval
      then now() + (p_recovery_ms::text || ' milliseconds')::interval
      else c.reap_frozen_until
    end,
    last_beat_at  = now(),
    last_sweep_at = now()
  where c.id
    -- THROTTLE: only the first beat after the window elapses matches → exactly one winner.
    and now() - c.last_sweep_at >= (p_throttle_ms::text || ' milliseconds')::interval
  returning true as should_sweep, (c.reap_frozen_until > now()) as reap_frozen;
$$;

comment on function public.try_begin_sweep(integer, integer, integer) is
  'Atomic throttle + control-plane-outage detect + recovery freeze for the universal lease '
  'sweep (enterprise-audit SCALE-01/CORR-01). Returns one row when the caller wins the '
  'throttle window (should_sweep=true, reap_frozen tells whether to skip reaping this '
  'cycle), zero rows when throttled out. ONLY heartbeat-driven callers use this — it ARMS '
  'the freeze from the inter-sweep gap, which is meaningful only for the heartbeat herd.';

-- Read-only freeze check for the NON-heartbeat callers (the daily cron floor, provision).
-- They must NOT arm the freeze (an idle fleet has a huge inter-beat gap that is NOT a
-- recovering herd — arming there would freeze the cron's own floor sweep and leak a
-- dead-but-rowed hub until traffic resumes), and the cron must NOT be throttled (it is the
-- guaranteed floor). But they DO respect a freeze a real heartbeat just armed, so a floor
-- sweep that lands inside a genuine control-plane recovery still defers (CORR-01 intact).
create or replace function public.reap_freeze_active()
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce((select reap_frozen_until > now() from public.sweep_coordinator where id), false);
$$;

comment on function public.reap_freeze_active() is
  'Read-only: is the lease-reap recovery freeze currently active? Used by the non-heartbeat '
  'floor callers (cron, provision) to respect a heartbeat-armed freeze WITHOUT arming one '
  'themselves or being throttled (enterprise-audit CORR-01 idle-fleet floor fix).';

-- Lock both down to service_role only (the sweep runs on the service-role client).
revoke all on function public.try_begin_sweep(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.try_begin_sweep(integer, integer, integer) to service_role;
revoke all on function public.reap_freeze_active() from public, anon, authenticated;
grant execute on function public.reap_freeze_active() to service_role;

-- The coordinator row holds no tenant data, but enable RLS with no policy so PostgREST
-- never exposes it to anon/authenticated (service_role bypasses RLS).
alter table public.sweep_coordinator enable row level security;
