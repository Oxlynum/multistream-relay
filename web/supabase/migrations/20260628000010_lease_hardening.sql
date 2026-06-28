-- Universal-lease HARDENING (termination-system-plan Phase 1, post-review fixes).
--
-- Closes the HIGH/MEDIUM/LOW findings from the adversarial review of 000009 that are
-- SQL-side:
--   * Theme C (#2/#3/#8/#12): the spawner tenant's reconnect lease (180s) was shorter
--     than the hub's own boot budget (VPS_READINESS_TIMEOUT_MS=300s), so the FIRST
--     user of a cold region was reaped mid-boot — before its hub was even serveable.
--     attach now seeds a 300s BOOT/first-connect lease; the TS promotion path
--     (handleVpsStatus) refreshes it once the hub is live (see status/route.ts).
--   * Theme A (#9): claim_hub_for_teardown's force path never re-read renew_deadline
--     under its row lock, so a hub that recovered between the sweep's snapshot and the
--     claim was still hard-destroyed (with all its tenants). The box-lease sweep now
--     passes p_require_lease_expired=true and the claim aborts if the hub renewed.
--   * Theme E (#16): the destructive/derived RPCs were EXECUTE-granted to anon +
--     authenticated (a latent griefing vector, neutralized today only by vps_hubs
--     RLS deny-all). Tighten to service_role only — these are server-only.
--
-- Additive + idempotent + convergent on a fresh replay AND the live schema.

-- ── 1. attach: seed a BOOT/first-connect lease that covers the hub readiness window ─
-- The 180s reconnect grace only makes sense AFTER the first successful stream. The
-- attach→first-frame window must cover hub boot (up to VPS_READINESS_TIMEOUT_MS=300s).
-- handleVpsStatus refreshes this to a fresh 300s once it promotes the tenant
-- provisioning→running, so a slow first-connect is then governed by the 5-min idle
-- grace, not the 3-min reconnect lease. Once streaming, Clock A renews RECONNECT_GRACE.
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

  update public.vps_hubs set empty_since = null where id = v_hub.id returning * into v_hub;

  -- Link the tenant AND start its BOOT/first-connect lease (300s = VPS_READINESS_TIMEOUT_MS).
  -- This is the lease that makes the tenant count toward derived occupancy. It must
  -- cover the hub's full boot budget so the first tenant of a cold region is not reaped
  -- before its hub is serveable (review #2/#3/#8/#12). RECONNECT_GRACE_MS (180s) takes
  -- over only once the tenant actually streams.
  update public.gpu_instances
    set vps_hub_id = v_hub.id,
        renew_deadline = now() + interval '300 seconds'
    where user_id = p_user_id;

  return v_hub;
end;
$$;

-- ── 2. claim_hub_for_teardown: re-validate the lease under the row lock (force path) ─
-- Adds p_require_lease_expired. The box-lease sweep (HARD destroy of a presumed-dead
-- hub) passes true: the claim re-reads renew_deadline under the FOR UPDATE lock and
-- ABORTS if the hub recovered (renewed its lease) after the sweep's snapshot read —
-- closing the TOCTOU that hard-destroyed a recovered multi-tenant hub (review #9).
-- Fatal-error / reclaim callers pass false (unconditional force, unchanged).
-- Signature change (2→3 args) ⇒ DROP then CREATE; the 3rd arg defaults so the existing
-- TS call shape stays valid.
drop function if exists public.claim_hub_for_teardown(uuid, boolean);
create or replace function public.claim_hub_for_teardown(
  p_hub_id uuid,
  p_only_if_empty boolean,
  p_require_lease_expired boolean default false
)
returns table(provider text, provider_id text, primary_ip_id text, hub_key_hash text)
language plpgsql
as $$
declare
  v_status   text;
  v_deadline timestamptz;
begin
  select status, renew_deadline into v_status, v_deadline
    from public.vps_hubs where id = p_hub_id for update;
  if not found or v_status = 'ended' then
    return;   -- gone, or another teardown already claimed it
  end if;
  -- Box-lease HARD destroy: only proceed if the lease is STILL expired under the lock.
  -- A heartbeat that renewed renew_deadline after the sweep's snapshot read (but before
  -- this claim) leaves a future deadline → the box recovered → abort (don't nuke it).
  if p_require_lease_expired and (v_deadline is null or v_deadline > now()) then
    return;
  end if;
  if p_only_if_empty and public.hub_active_tenant_count(p_hub_id) > 0 then
    return;   -- a live-lease tenant raced in — leave the box up
  end if;
  return query
    update public.vps_hubs set status = 'ended' where id = p_hub_id
    returning vps_hubs.provider, vps_hubs.provider_id, vps_hubs.primary_ip_id, vps_hubs.hub_key_hash;
end;
$$;
comment on function public.claim_hub_for_teardown(uuid, boolean, boolean) is
  'Atomic teardown claim under a row lock. onlyIfEmpty uses the DERIVED live-lease count; requireLeaseExpired re-checks renew_deadline so a recovered hub is not hard-destroyed (review #9). service_role only.';

-- ── 3. Tighten grants on the server-only destructive/derived RPCs (review #16) ──────
-- These are called exclusively by the service-role client (sweeper / heartbeat). The
-- 000009 anon+authenticated grants were a latent privilege-escalation footgun (a future
-- permissive vps_hubs RLS policy would let any logged-in user end any shared hub). Make
-- them service_role only and strip the default PUBLIC grant.
revoke execute on function public.claim_hub_for_teardown(uuid, boolean, boolean) from public;
revoke all on function public.hub_active_tenant_count(uuid) from public, anon, authenticated;
revoke all on function public.reconcile_hub_emptiness(uuid) from public, anon, authenticated;
grant execute on function public.claim_hub_for_teardown(uuid, boolean, boolean) to service_role;
grant execute on function public.hub_active_tenant_count(uuid) to service_role;
grant execute on function public.reconcile_hub_emptiness(uuid) to service_role;
