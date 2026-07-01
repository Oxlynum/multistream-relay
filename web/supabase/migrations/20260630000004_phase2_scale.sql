-- Phase 2 scale/reliability completion (enterprise-audit SCALE-03 + SCALE-02 + REL-05).
-- PURELY ADDITIVE: one function REPLACE (behaviour-preserving guard), one new index, one
-- new throttle table + function. Touches no lease/teardown/billing semantics.
--
-- 1. SCALE-03 — guard reconcile_hub_emptiness's no-op UPDATE. The old body wrote vps_hubs
--    on EVERY call even when empty_since was unchanged; it is called per-hub per heartbeat
--    AND again per-hub inside every fleet sweep, concentrating ~1000 no-op UPDATEs/sec on a
--    tiny hot row set at 30 hubs (row-lock contention + dead-tuple/WAL bloat).
-- 2. SCALE-02/REL-04 — BRIN index on connection_metrics.recorded_at so the (finally
--    scheduled) retention prune range-scans the aged tail instead of seq-scanning the heap.
-- 3. REL-05/SCALE-02 — a generic fleet-wide periodic-task throttle (periodic_tasks +
--    try_begin_periodic) so the heartbeat sweep can self-schedule the expensive, low-
--    frequency jobs (row-less-orphan reconcile, metrics prune) WITHOUT a sub-daily cron
--    (Vercel Hobby caps crons at daily → a row-less orphan box would bill up to 24h).

-- ── 1. SCALE-03: reconcile_hub_emptiness only writes when empty_since actually changes ──
-- Signature + return shape + security context are IDENTICAL to 000009 (SECURITY INVOKER,
-- called on the service-role client). It still RETURNS the correct empty_since on a no-op,
-- so Clock B / the sweeper's scale-to-zero decision is byte-for-byte unchanged.
create or replace function public.reconcile_hub_emptiness(p_hub_id uuid)
returns table(out_active_count integer, out_empty_since timestamptz)
language plpgsql
as $$
declare
  v_count int;
  v_old   timestamptz;
  v_new   timestamptz;
begin
  v_count := public.hub_active_tenant_count(p_hub_id);
  -- Read the current marker: needed both to compute the next value (coalesce keeps the
  -- FIRST-observed empty time) and to decide whether a write is even necessary.
  select empty_since into v_old from public.vps_hubs where id = p_hub_id;
  v_new := case when v_count = 0 then coalesce(v_old, now()) else null end;
  -- Only write on an actual change (SCALE-03). No-op cases skipped entirely:
  --   count=0 & already-stamped   → v_new = v_old        → skip
  --   count>0 & already-null      → v_new = null = v_old → skip
  if v_new is distinct from v_old then
    update public.vps_hubs set empty_since = v_new where id = p_hub_id;
  end if;
  out_active_count := v_count;
  out_empty_since  := v_new;
  return next;
end;
$$;
comment on function public.reconcile_hub_emptiness(uuid) is
  'Reconciles vps_hubs.empty_since from the DERIVED live-lease count and returns (count, '
  'empty_since). SCALE-03: writes ONLY when empty_since changes (guards the per-beat/per-'
  'sweep no-op UPDATE) while returning the same value as before. Called by Clock B + sweeper.';

-- ── 2. SCALE-02/REL-04: BRIN index on the append-only recorded_at timestamp ──
-- BRIN (not btree): connection_metrics is insert-ordered by time, so a block-range index is
-- a few pages vs a full btree, and the retention DELETE (recorded_at < now()-24h) becomes a
-- bounded range scan of the oldest blocks.
create index if not exists connection_metrics_recorded_at_brin
  on public.connection_metrics using brin (recorded_at);

-- ── 3. REL-05/SCALE-02: generic fleet-wide periodic-task throttle ──
-- Same atomic-CAS idea as try_begin_sweep (000003) but for LONGER, task-specific cadences.
-- One winner per window across the WHOLE fleet; every other beat's call is a cheap no-op.
create table if not exists public.periodic_tasks (
  task        text primary key,
  last_run_at timestamptz not null default 'epoch'::timestamptz
);

-- Returns true to at MOST ONE caller per p_throttle_ms window (for p_task), false to all
-- others. First-ever call inserts + wins; later calls fire the conditional ON CONFLICT
-- UPDATE only when the stored last_run_at is older than the window, so exactly one
-- concurrent caller past the window updates + RETURNs true and the rest RETURN nothing.
create or replace function public.try_begin_periodic(p_task text, p_throttle_ms integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_won boolean;
begin
  insert into public.periodic_tasks as pt (task, last_run_at)
  values (p_task, now())
  on conflict (task) do update
    set last_run_at = now()
    where pt.last_run_at < now() - (p_throttle_ms::text || ' milliseconds')::interval
  returning true into v_won;
  return coalesce(v_won, false);
end;
$$;

comment on function public.try_begin_periodic(text, integer) is
  'Atomic fleet-wide throttle for expensive low-frequency jobs (REL-05 row-less-orphan '
  'reconcile, SCALE-02 metrics prune). Returns true to at most one caller per p_throttle_ms '
  'window per task, false to all others — lets the heartbeat sweep self-schedule sub-daily '
  'maintenance with no sub-daily cron (Vercel Hobby caps crons at daily).';

-- service_role-only (the sweep/reconcile run on the service-role client), mirroring 000003.
revoke all on function public.try_begin_periodic(text, integer) from public, anon, authenticated;
grant execute on function public.try_begin_periodic(text, integer) to service_role;

-- The table holds no tenant data, but enable RLS with no policy so PostgREST never exposes
-- it to anon/authenticated (service_role bypasses RLS).
alter table public.periodic_tasks enable row level security;
