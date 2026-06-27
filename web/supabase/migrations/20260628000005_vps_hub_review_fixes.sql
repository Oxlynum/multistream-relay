-- VPS-as-the-Hub Phase 1 — review fixes (adversarial review 2026-06-28).
-- Additive; inert until SLIMCAST_VPS_HUB. Deploy with: supabase db push

-- attach_session_to_hub: add a LIVENESS guard for 'live' hubs (skip a crashed box
-- that stopped heartbeating) and an AGE guard for 'spawning' hubs (skip a stuck
-- spawn that never came live) — so neither poisons new attaches (review #5/#17).
-- 150s mirrors the reaper STALE_S; 300s mirrors VPS_READINESS_TIMEOUT_MS.
create or replace function public.attach_session_to_hub(p_user_id uuid, p_region text)
returns public.vps_hubs
language plpgsql
as $$
declare
  v_hub      public.vps_hubs;
  v_existing uuid;
begin
  -- idempotency: a re-provision / retry must not double-count
  select vps_hub_id into v_existing from public.gpu_instances where user_id = p_user_id;
  if v_existing is not null then
    select * into v_hub from public.vps_hubs where id = v_existing;
    return v_hub;
  end if;

  select * into v_hub
  from public.vps_hubs
  where region = p_region
    and session_count < max_sessions
    and (
      (status = 'live' and last_seen_at is not null and last_seen_at > now() - interval '150 seconds')
      or (status = 'spawning' and created_at > now() - interval '300 seconds')
    )
  order by (status = 'live') desc, session_count desc   -- prefer live, then fullest
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  update public.vps_hubs
    set session_count = session_count + 1, empty_since = null
    where id = v_hub.id
    returning * into v_hub;
  update public.gpu_instances set vps_hub_id = v_hub.id where user_id = p_user_id;

  return v_hub;
end;
$$;

-- Defense-in-depth (review #18): vps_hub_id must only ever be set by the attach RPC
-- (service role). Stop clients from PATCHing it directly via PostgREST, which would
-- bypass the refcount increment and corrupt scale-to-zero. Service role bypasses
-- column grants; the user's other gpu_instances updates are unaffected.
revoke update (vps_hub_id) on public.gpu_instances from authenticated, anon;
