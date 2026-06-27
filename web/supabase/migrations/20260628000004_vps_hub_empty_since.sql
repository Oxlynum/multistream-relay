-- VPS-as-the-Hub Phase 1 (S11): scale-to-zero bookkeeping.
-- A hub heartbeats even when it has zero tenants, so heartbeat staleness can't tell
-- "idle-empty" from "alive". Track when a hub became empty so Clock B can apply the
-- idle grace before destroying it. Additive. Deploy with: supabase db push

alter table public.vps_hubs add column if not exists empty_since timestamptz;

-- detach: set empty_since the moment the decrement empties the hub (idempotent —
-- only stamps if not already set), so the grace window starts then.
create or replace function public.detach_from_hub(p_hub_id uuid)
returns void
language plpgsql
as $$
declare
  v_new int;
begin
  update public.vps_hubs
    set session_count = greatest(session_count - 1, 0)
    where id = p_hub_id
    returning session_count into v_new;
  if v_new = 0 then
    update public.vps_hubs set empty_since = now() where id = p_hub_id and empty_since is null;
  end if;
end;
$$;

-- attach: clear empty_since on any successful attach (the hub is no longer idle).
create or replace function public.attach_session_to_hub(p_user_id uuid, p_region text)
returns public.vps_hubs
language plpgsql
as $$
declare
  v_hub      public.vps_hubs;
  v_existing uuid;
begin
  select vps_hub_id into v_existing from public.gpu_instances where user_id = p_user_id;
  if v_existing is not null then
    select * into v_hub from public.vps_hubs where id = v_existing;
    return v_hub;
  end if;

  select * into v_hub
  from public.vps_hubs
  where region = p_region and status in ('live', 'spawning') and session_count < max_sessions
  order by (status = 'live') desc, session_count desc
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
