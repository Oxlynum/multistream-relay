-- Asserts for the universal-lease migration (20260628000009). Runs AFTER bootstrap +
-- migration. Validates the root-cause fix: DERIVED emptiness (no stored counter),
-- the race-safe teardown claim, the tenant lease, attach capacity, the detach no-op,
-- and that session_count is gone. Any failure RAISEs and ON_ERROR_STOP aborts.

do $$
declare
  v_hub   uuid;
  v_hub2  uuid;
  v_cnt   int;
  v_empty timestamptz;
  v_dl    timestamptz;
  v_row   record;
  v_status text;
begin
  -- ── 0. Schema shape ────────────────────────────────────────────────────────
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='vps_hubs' and column_name='session_count') then
    raise exception 'FAIL: vps_hubs.session_count should have been DROPPED';
  end if;
  raise notice 'PASS: session_count column dropped';

  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='gpu_instances' and column_name='renew_deadline')
  or not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='relay_nodes' and column_name='renew_deadline')
  or not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='vps_hubs' and column_name='renew_deadline') then
    raise exception 'FAIL: renew_deadline missing on one of the three billable tables';
  end if;
  raise notice 'PASS: renew_deadline present on all three tables';

  -- ── 1. Seed a live hub + three unattached sessions ─────────────────────────
  insert into public.vps_hubs (region, status, max_sessions, last_seen_at, provider, provider_id, primary_ip_id, hub_key_hash)
    values ('eu', 'live', 10, now(), 'hetzner', 'srv-1', 'ip-1', 'hash-1') returning id into v_hub;
  insert into public.gpu_instances (user_id) values ('00000000-0000-0000-0000-000000000001');
  insert into public.gpu_instances (user_id) values ('00000000-0000-0000-0000-000000000002');
  insert into public.gpu_instances (user_id) values ('00000000-0000-0000-0000-000000000003');

  -- ── 2. attach starts the tenant lease + sets vps_hub_id; capacity is DERIVED ─
  perform public.attach_session_to_hub('00000000-0000-0000-0000-000000000001', 'eu');
  select vps_hub_id, renew_deadline into v_hub2, v_dl
    from public.gpu_instances where user_id='00000000-0000-0000-0000-000000000001';
  if v_hub2 is distinct from v_hub then raise exception 'FAIL: attach did not link tenant to the hub'; end if;
  -- HARDENING (000010 review #2/#3): attach seeds a 300s BOOT/first-connect lease (was
  -- 180s) so the first tenant of a slow-spawning hub is not reaped before its hub boots.
  if v_dl is null or v_dl < now() + interval '290 seconds' or v_dl > now() + interval '310 seconds' then
    raise exception 'FAIL: attach did not set a ~300s boot lease (got %)', v_dl;
  end if;
  raise notice 'PASS: attach links tenant + starts 300s boot lease (covers hub spawn window)';

  if public.hub_active_tenant_count(v_hub) <> 1 then
    raise exception 'FAIL: derived tenant count should be 1 (got %)', public.hub_active_tenant_count(v_hub);
  end if;
  perform public.attach_session_to_hub('00000000-0000-0000-0000-000000000002', 'eu');
  if public.hub_active_tenant_count(v_hub) <> 2 then
    raise exception 'FAIL: derived tenant count should be 2 (got %)', public.hub_active_tenant_count(v_hub);
  end if;
  raise notice 'PASS: derived tenant count tracks live-lease attaches (2)';

  -- ── 3. A LAPSED lease drops a tenant from the derived count (the wedge fix) ──
  update public.gpu_instances set renew_deadline = now() - interval '1 second'
    where user_id='00000000-0000-0000-0000-000000000001';
  if public.hub_active_tenant_count(v_hub) <> 1 then
    raise exception 'FAIL: lapsed-lease tenant should drop out of the count (got %)', public.hub_active_tenant_count(v_hub);
  end if;
  raise notice 'PASS: lapsed lease drops tenant from derived count (no stored counter to wedge)';

  -- ── 4. reconcile_hub_emptiness clears/sets empty_since from the derived count ─
  select out_active_count, out_empty_since into v_cnt, v_empty
    from public.reconcile_hub_emptiness(v_hub);
  if v_cnt <> 1 or v_empty is not null then
    raise exception 'FAIL: reconcile with a live tenant must report count=1 + empty_since NULL (got %, %)', v_cnt, v_empty;
  end if;
  raise notice 'PASS: reconcile clears empty_since while a tenant is live';

  update public.gpu_instances set renew_deadline = now() - interval '1 second'
    where user_id='00000000-0000-0000-0000-000000000002';
  select out_active_count, out_empty_since into v_cnt, v_empty
    from public.reconcile_hub_emptiness(v_hub);
  if v_cnt <> 0 or v_empty is null then
    raise exception 'FAIL: reconcile with zero live tenants must set empty_since (got count=%, empty=%)', v_cnt, v_empty;
  end if;
  raise notice 'PASS: reconcile sets empty_since when derived-empty';

  -- ── 5. claim_hub_for_teardown(onlyIfEmpty) SUCCEEDS when derived-empty ──────
  select * into v_row from public.claim_hub_for_teardown(v_hub, true);
  if v_row.provider_id is distinct from 'srv-1' then
    raise exception 'FAIL: claim should return the hub row when empty (got %)', v_row;
  end if;
  select status into v_status from public.vps_hubs where id=v_hub;
  if v_status <> 'ended' then raise exception 'FAIL: claim should flip status to ended'; end if;
  raise notice 'PASS: claim_hub_for_teardown destroys an empty hub';

  -- ── 6. claim(onlyIfEmpty) ABORTS when a live-lease tenant exists ────────────
  insert into public.vps_hubs (region, status, max_sessions, last_seen_at, provider, provider_id, hub_key_hash)
    values ('eu', 'live', 10, now(), 'hetzner', 'srv-2', 'hash-2') returning id into v_hub2;
  insert into public.gpu_instances (user_id) values ('00000000-0000-0000-0000-000000000004');
  perform public.attach_session_to_hub('00000000-0000-0000-0000-000000000004', 'eu');
  if (select count(*) from public.claim_hub_for_teardown(v_hub2, true)) <> 0 then
    raise exception 'FAIL: claim(onlyIfEmpty) must ABORT with a live tenant present';
  end if;
  select status into v_status from public.vps_hubs where id=v_hub2;
  if v_status <> 'live' then raise exception 'FAIL: aborted claim must leave status live (got %)', v_status; end if;
  raise notice 'PASS: claim(onlyIfEmpty) aborts when a tenant raced in (race-safe barrier)';

  -- ── 7. claim(force) destroys even with a live tenant ───────────────────────
  if (select count(*) from public.claim_hub_for_teardown(v_hub2, false)) <> 1 then
    raise exception 'FAIL: forced claim must succeed';
  end if;
  raise notice 'PASS: forced claim destroys a hub with live tenants (box-dead path)';

  -- ── 8. detach_from_hub is a NO-OP ──────────────────────────────────────────
  perform public.detach_from_hub(v_hub2);   -- must not error or mutate anything
  raise notice 'PASS: detach_from_hub is a harmless no-op';

  -- ── 9. attach capacity uses the DERIVED count (cannot exceed max_sessions) ──
  insert into public.vps_hubs (region, status, max_sessions, last_seen_at, provider, provider_id, hub_key_hash)
    values ('us', 'live', 2, now(), 'hetzner', 'srv-3', 'hash-3') returning id into v_hub;
  insert into public.gpu_instances (user_id) values ('00000000-0000-0000-0000-000000000005');
  insert into public.gpu_instances (user_id) values ('00000000-0000-0000-0000-000000000006');
  insert into public.gpu_instances (user_id) values ('00000000-0000-0000-0000-000000000007');
  perform public.attach_session_to_hub('00000000-0000-0000-0000-000000000005', 'us');
  perform public.attach_session_to_hub('00000000-0000-0000-0000-000000000006', 'us');
  -- hub now at derived capacity (2/2). A 3rd attach must find no hub → return NULL.
  if (public.attach_session_to_hub('00000000-0000-0000-0000-000000000007', 'us')).id is not null then
    raise exception 'FAIL: attach must refuse a full hub (derived capacity)';
  end if;
  if (select vps_hub_id from public.gpu_instances where user_id='00000000-0000-0000-0000-000000000007') is not null then
    raise exception 'FAIL: over-capacity tenant must not be linked';
  end if;
  raise notice 'PASS: attach enforces max_sessions via derived count';

  -- ── 10. HARDENING (000010 review #9): claim_hub_for_teardown(requireLeaseExpired) ──
  -- The box-lease HARD-destroy path must re-check renew_deadline under the row lock and
  -- ABORT if the hub recovered (renewed) after the sweep's snapshot — so a transient
  -- partition can't nuke a recovered multi-tenant box.
  insert into public.vps_hubs (region, status, max_sessions, last_seen_at, provider, provider_id, hub_key_hash, renew_deadline)
    values ('eu', 'live', 10, now(), 'hetzner', 'srv-hard', 'hash-hard', now() + interval '120 seconds')
    returning id into v_hub;
  -- lease in the FUTURE (box recovered) → requireLeaseExpired must ABORT
  if (select count(*) from public.claim_hub_for_teardown(v_hub, false, true)) <> 0 then
    raise exception 'FAIL: claim(requireLeaseExpired) must ABORT a hub whose lease is still valid (recovered)';
  end if;
  select status into v_status from public.vps_hubs where id=v_hub;
  if v_status <> 'live' then raise exception 'FAIL: aborted box-lease claim must leave hub live (got %)', v_status; end if;
  raise notice 'PASS: claim(requireLeaseExpired) aborts a recovered hub (TOCTOU fix)';
  -- lease in the PAST (box truly dead) → requireLeaseExpired proceeds
  update public.vps_hubs set renew_deadline = now() - interval '1 second' where id = v_hub;
  if (select count(*) from public.claim_hub_for_teardown(v_hub, false, true)) <> 1 then
    raise exception 'FAIL: claim(requireLeaseExpired) must SUCCEED when the lease is genuinely expired';
  end if;
  select status into v_status from public.vps_hubs where id=v_hub;
  if v_status <> 'ended' then raise exception 'FAIL: expired-lease box claim must end the hub (got %)', v_status; end if;
  raise notice 'PASS: claim(requireLeaseExpired) destroys a truly-dead hub';

  -- ── 11. HARDENING: the 2-arg claim call shape still works (3rd arg defaults false) ──
  insert into public.vps_hubs (region, status, max_sessions, last_seen_at, provider, provider_id, hub_key_hash, renew_deadline)
    values ('eu', 'live', 10, now(), 'hetzner', 'srv-def', 'hash-def', now() + interval '120 seconds')
    returning id into v_hub;
  if (select count(*) from public.claim_hub_for_teardown(v_hub, false)) <> 1 then
    raise exception 'FAIL: 2-arg claim (force, default requireLeaseExpired=false) must still destroy unconditionally';
  end if;
  raise notice 'PASS: 2-arg claim_hub_for_teardown still forces (back-compat default)';

  raise notice '======================================================';
  raise notice 'ALL UNIVERSAL-LEASE ASSERTS PASSED';
  raise notice '======================================================';
end $$;
