-- Universal termination lease (termination-system-plan.md Phase 1).
--
-- Closes the orphaned-Hetzner-hub incident class by replacing the wedge-prone
-- STORED refcount (vps_hubs.session_count) with DERIVED emptiness computed from
-- live leases, and by giving every billable row a heartbeat-renewed lease that a
-- single provider-blind sweeper can reap — no daily-cron dependency.
--
-- The model (§9):
--   * renew_deadline on all three billable tables. Renewed by the relay→Vercel
--     heartbeat (box lease, ~120s window) for boxes, and by OBS-source-present
--     (tenant reconnect lease, ~180s) for shared-hub tenants. A box/tenant whose
--     lease lapses is past renew_deadline and gets swept.
--   * Hub emptiness is DERIVED: count(gpu_instances WHERE vps_hub_id=h AND
--     renew_deadline > now()). Reconciled by construction on every evaluation —
--     a lost detach can no longer strand a stored counter > 0. This is the
--     actual root-cause fix.
--
-- Additive + idempotent + convergent on BOTH a fresh history replay and the live
-- schema. Inert with respect to the legacy all-in-one pod path (which gains only
-- the renew_deadline lease, written by the existing pod heartbeat).

-- ── 1. Lease column on every billable row ────────────────────────────────────
alter table public.gpu_instances add column if not exists renew_deadline timestamptz;
alter table public.relay_nodes   add column if not exists renew_deadline timestamptz;
alter table public.vps_hubs       add column if not exists renew_deadline timestamptz;

comment on column public.gpu_instances.renew_deadline is
  'Universal lease. Legacy pod = box lease (heartbeat, ~120s). Hub tenant = reconnect lease (OBS source present, ~180s). Past now() → swept.';
comment on column public.relay_nodes.renew_deadline is
  'GPU-backend box lease, renewed by the node heartbeat (~120s). Past now() with a dead parent → swept.';
comment on column public.vps_hubs.renew_deadline is
  'Hub box lease, renewed by the hub heartbeat (~120s). Past now() → hub box is a zombie → hard-destroyed. Closes the dead-agent incident.';

-- Backfill live rows with a generous lease so the redeployed code has time to
-- start renewing before anything is reaped. Gated on NULL so re-runs are no-ops.
update public.gpu_instances set renew_deadline = now() + interval '15 minutes'
  where status <> 'stopped' and renew_deadline is null;
update public.relay_nodes set renew_deadline = now() + interval '15 minutes'
  where renew_deadline is null;
update public.vps_hubs set renew_deadline = now() + interval '15 minutes'
  where status <> 'ended' and renew_deadline is null;

-- ── 2. Derived emptiness — the root-cause fix (never a stored counter) ────────
create or replace function public.hub_active_tenant_count(p_hub_id uuid)
returns integer
language sql stable
as $$
  select count(*)::int
  from public.gpu_instances
  where vps_hub_id = p_hub_id
    and renew_deadline > now();
$$;
comment on function public.hub_active_tenant_count(uuid) is
  'DERIVED hub occupancy from live leases. Reconciled by construction every call — replaces the wedge-prone vps_hubs.session_count.';

-- Reconcile empty_since from the derived count. empty_since is now a DERIVED grace
-- timer ("empty since when"), never a side effect of a blind decrement: set on
-- first observation of emptiness, cleared the instant a live-lease tenant exists.
-- Both heartbeat Clock B and the sweeper call this so the timer can't desync.
create or replace function public.reconcile_hub_emptiness(p_hub_id uuid)
returns table(out_active_count integer, out_empty_since timestamptz)
language plpgsql
as $$
declare
  v_count int;
  v_empty timestamptz;
begin
  v_count := public.hub_active_tenant_count(p_hub_id);
  update public.vps_hubs
    set empty_since = case when v_count = 0 then coalesce(empty_since, now()) else null end
    where id = p_hub_id
    returning empty_since into v_empty;
  out_active_count := v_count;
  out_empty_since  := v_empty;
  return next;
end;
$$;
comment on function public.reconcile_hub_emptiness(uuid) is
  'Reconciles vps_hubs.empty_since from the DERIVED live-lease count and returns (count, empty_since). Called by Clock B + the lease sweeper.';

-- Race-safe teardown claim with DERIVED emptiness. Replaces the old
-- `.eq(session_count, 0)` single-row drain barrier (a derived count can't be a
-- column predicate). Locks the hub row FOR UPDATE so it serializes against
-- attach_session_to_hub's own FOR UPDATE on the same row: a tenant that just
-- attached is committed-and-counted before this claim proceeds, so onlyIfEmpty
-- aborts rather than destroying a box a tenant just joined. Returns the columns
-- teardownHub needs (empty result set = aborted / already ended).
create or replace function public.claim_hub_for_teardown(p_hub_id uuid, p_only_if_empty boolean)
returns table(provider text, provider_id text, primary_ip_id text, hub_key_hash text)
language plpgsql
as $$
declare
  v_status text;
begin
  select status into v_status from public.vps_hubs where id = p_hub_id for update;
  if not found or v_status = 'ended' then
    return;   -- gone, or another teardown already claimed it
  end if;
  if p_only_if_empty and public.hub_active_tenant_count(p_hub_id) > 0 then
    return;   -- a live-lease tenant raced in — leave the box up
  end if;
  return query
    update public.vps_hubs set status = 'ended' where id = p_hub_id
    returning vps_hubs.provider, vps_hubs.provider_id, vps_hubs.primary_ip_id, vps_hubs.hub_key_hash;
end;
$$;
comment on function public.claim_hub_for_teardown(uuid, boolean) is
  'Atomic teardown claim. onlyIfEmpty uses the DERIVED live-lease count under a row lock (race-safe vs attach). Replaces the session_count=0 barrier.';

-- ── 3. attach: DERIVED capacity + start the tenant lease, no stored counter ───
create or replace function public.attach_session_to_hub(p_user_id uuid, p_region text)
returns public.vps_hubs
language plpgsql
as $$
declare
  v_hub      public.vps_hubs;
  v_existing uuid;
begin
  -- Idempotency: a re-provision / retry must not double-attach.
  select vps_hub_id into v_existing from public.gpu_instances where user_id = p_user_id;
  if v_existing is not null then
    select * into v_hub from public.vps_hubs where id = v_existing;
    return v_hub;
  end if;

  -- DERIVED capacity (hub_active_tenant_count) replaces `session_count < max_sessions`.
  select * into v_hub
  from public.vps_hubs
  where region = p_region
    and (
      (status = 'live' and last_seen_at is not null and last_seen_at > now() - interval '150 seconds')
      or (status = 'spawning' and created_at > now() - interval '300 seconds')
    )
    and public.hub_active_tenant_count(id) < max_sessions
  order by (status = 'live') desc, public.hub_active_tenant_count(id) desc   -- prefer live, then fullest
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  -- Clear the scale-to-zero clock (a tenant is joining) — empty_since is otherwise
  -- reconciled from the derived count by reconcile_hub_emptiness on each heartbeat.
  update public.vps_hubs set empty_since = null where id = v_hub.id returning * into v_hub;

  -- Link the tenant AND start its reconnect lease (180s; mirrors RECONNECT_GRACE_MS).
  -- The lease is what makes the tenant count toward derived occupancy.
  update public.gpu_instances
    set vps_hub_id = v_hub.id,
        renew_deadline = now() + interval '180 seconds'
    where user_id = p_user_id;

  return v_hub;
end;
$$;

-- ── 4. detach: now a no-op — emptiness is derived, never decremented ──────────
create or replace function public.detach_from_hub(p_hub_id uuid)
returns void
language plpgsql
as $$
begin
  -- No-op by design. Occupancy is DERIVED from live leases (renew_deadline): a
  -- detached tenant simply stops being counted once its gpu_instances row is
  -- deleted (teardownInstance) or its lease lapses. Kept callable so any
  -- in-flight caller mid-deploy can't error; teardownInstance no longer calls it.
  return;
end;
$$;
comment on function public.detach_from_hub(uuid) is
  'No-op since Phase 1 universal lease — hub occupancy is derived from live leases, not a stored counter.';

-- ── 5. Drop the stored refcount (acceptance criterion: no stored counter) ─────
-- All readers/writers removed in this migration (RPCs above) and the TS edits in
-- the same change. Idempotent for fresh-replay + live convergence.
alter table public.vps_hubs drop column if exists session_count;

-- ── 6. Grants (match the attach/detach convention; called server-side) ────────
grant execute on function public.hub_active_tenant_count(uuid)  to anon, authenticated, service_role;
grant execute on function public.reconcile_hub_emptiness(uuid)  to anon, authenticated, service_role;
grant execute on function public.claim_hub_for_teardown(uuid, boolean) to anon, authenticated, service_role;
