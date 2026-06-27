-- VPS-as-the-Hub Phase 1 (S5): hub shared secrets + attach-to-spawning-hub.
-- Additive; inert until SLIMCAST_VPS_HUB. Deploy with: supabase db push

-- The hub runs a MediaMTX WILDCARD path with ONE shared SRT passphrase (per the
-- resolved Phase-1 decision: tenant isolation rests on the unguessable 24-char
-- streamid, not per-path passphrases — avoids config reloads that could drop other
-- tenants' live SRT sessions). So the passphrase is a property of the BOX, stored
-- here so any session attaching later can be stamped with it for its srt_url.
-- panel_password = the hub's :8080 debug-panel RELAY_PASSWORD (stored for ops access).
alter table public.vps_hubs
  add column if not exists srt_passphrase text,
  add column if not exists panel_password text;

-- Redefine attach to also let EARLY JOINERS attach to a hub that is still 'spawning'
-- (not just 'live'). This is how a second concurrent user in an empty region joins
-- the in-progress box instead of spawning a duplicate (the spawn-lock blocks a 2nd
-- spawn; the loser attaches here). The caller stamps the session's status from the
-- returned hub.status: 'live' → session 'running' (serveable now); 'spawning' →
-- session 'provisioning' (becomes serveable when the hub POSTs /ready).
create or replace function public.attach_session_to_hub(p_user_id uuid, p_region text)
returns public.vps_hubs
language plpgsql
as $$
declare
  v_hub      public.vps_hubs;
  v_existing uuid;
begin
  -- idempotency: a re-provision (rate-limited 5/60) or Vercel retry must not double-count
  select vps_hub_id into v_existing from public.gpu_instances where user_id = p_user_id;
  if v_existing is not null then
    select * into v_hub from public.vps_hubs where id = v_existing;
    return v_hub;   -- already attached
  end if;

  select * into v_hub
  from public.vps_hubs
  where region = p_region and status in ('live', 'spawning') and session_count < max_sessions
  order by (status = 'live') desc, session_count desc   -- prefer live, then fullest (bin packing)
  limit 1
  for update skip locked;

  if not found then
    return null;    -- caller spawns a hub
  end if;

  update public.vps_hubs   set session_count = session_count + 1 where id = v_hub.id
    returning * into v_hub;
  update public.gpu_instances set vps_hub_id = v_hub.id          where user_id = p_user_id;

  return v_hub;
end;
$$;
