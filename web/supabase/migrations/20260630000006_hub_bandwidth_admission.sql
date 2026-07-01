-- COST-03: bandwidth-aware hub admission.
--
-- attach_session_to_hub admitted purely on tenant COUNT (< max_sessions = 10). Each transcode
-- tenant drives ~13 GB/hr of hub egress (bridge leg to the GPU + platform fan-out), so 10 of
-- them ≈ 130 GB/hr ≈ ~94 TB/mo — ~4.7× a cx33's 20 TB Hetzner bundle → per-TB overage that
-- silently turns a ~€12/mo hub into €70+/mo. This adds a per-hub egress-HEADROOM check so a
-- bandwidth-heavy hub stops accepting new tenants (the broker then spawns/uses another hub,
-- spreading load — each hub has its own 20 TB bundle). Count cap stays as the hard backstop.
--
-- Ceiling: GUC `slimcast.hub_max_egress_gb_hr`, default 35 GB/hr. A cx33 24/7 exactly hits its
-- 20 TB bundle at ~27.8 GB/hr; hubs scale-to-zero when idle, so 35 leaves headroom while still
-- catching the multi-transcode blowout. NB the per-tenant egress figure is an ESTIMATE until the
-- GPU transcode bridge runs live — re-tune with real data:
--   ALTER DATABASE postgres SET slimcast.hub_max_egress_gb_hr = <n>;
--
-- SAFE ceiling read: a mistyped GUC (e.g. 'slimcast.hub_max_egress_gb_hr' = '35gb') would make
-- an inline ::numeric cast THROW inside attach_session_to_hub → every hub attach errors → a
-- provisioning OUTAGE from a config typo. This helper catches any parse error and falls back to
-- the default, so a bad GUC degrades to "no bandwidth cap at 35" rather than breaking provisioning.
create or replace function public.hub_egress_ceiling_gb_hr() returns numeric
language plpgsql stable as $$
begin
  return coalesce(nullif(current_setting('slimcast.hub_max_egress_gb_hr', true), '')::numeric, 35);
exception when others then
  return 35;
end;
$$;

-- Signature UNCHANGED (2-arg), so it cleanly REPLACES the 000010 definition (no overload/drop);
-- the body below is 000010's verbatim plus one added WHERE clause. Additive + idempotent.
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
    -- COST-03: bandwidth headroom. Skip a hub whose last-reported aggregate egress is already at
    -- the ceiling (a fresh hub reports null → 0, so its first tenant always admits). GUC-tunable
    -- via hub_egress_ceiling_gb_hr() (safe-cast, defaults 35 on a bad/unset GUC).
    and coalesce(egress_gb_hr, 0) < public.hub_egress_ceiling_gb_hr()
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
