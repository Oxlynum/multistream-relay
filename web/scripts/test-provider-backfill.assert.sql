-- Assert the 000011 provider backfill produced the correct, convergent result.
-- Run AFTER bootstrap + the migration (and a second time to prove idempotence).
-- Any failed assertion raises an exception → psql -v ON_ERROR_STOP=1 exits non-zero.

do $$
declare
  v text;
begin
  -- gpu_instances: every blank → 'vast'; the already-correct row unchanged.
  select provider into v from public.gpu_instances where tag = 'gpu_blank_empty';
  assert v = 'vast', format('gpu_blank_empty: expected vast, got %L', v);
  select provider into v from public.gpu_instances where tag = 'gpu_blank_null';
  assert v = 'vast', format('gpu_blank_null: expected vast, got %L', v);
  select provider into v from public.gpu_instances where tag = 'gpu_already_vast';
  assert v = 'vast', format('gpu_already_vast: expected vast, got %L', v);

  -- relay_nodes: blank recovered from the row's OWN racer (never assumed 'vast'); a blank
  -- with no racer stays blank; an already-stamped row is untouched.
  select provider into v from public.relay_nodes where tag = 'node_blank_runpod';
  assert v = 'runpod', format('node_blank_runpod: expected runpod (from racer), got %L', v);
  select provider into v from public.relay_nodes where tag = 'node_blank_vast';
  assert v = 'vast', format('node_blank_vast: expected vast (from racer), got %L', v);
  select provider into v from public.relay_nodes where tag = 'node_blank_norace';
  assert v = '', format('node_blank_norace: expected '''' (no racer to recover), got %L', v);
  select provider into v from public.relay_nodes where tag = 'node_already_set';
  assert v = 'runpod', format('node_already_set: expected runpod (unchanged), got %L', v);

  -- vps_hubs: every blank → 'hetzner'; the already-correct row unchanged.
  select provider into v from public.vps_hubs where tag = 'hub_blank_empty';
  assert v = 'hetzner', format('hub_blank_empty: expected hetzner, got %L', v);
  select provider into v from public.vps_hubs where tag = 'hub_blank_null';
  assert v = 'hetzner', format('hub_blank_null: expected hetzner, got %L', v);
  select provider into v from public.vps_hubs where tag = 'hub_already_set';
  assert v = 'hetzner', format('hub_already_set: expected hetzner (unchanged), got %L', v);

  -- No blank providers remain anywhere a box could be routed from (the goal: strict
  -- getProvider never trips on real data). The no-racer relay_node is the sole allowed
  -- residual blank (it has no provider_id to route → orphan reconcile backstops it).
  assert (select count(*) from public.gpu_instances where coalesce(provider,'') = '') = 0,
    'gpu_instances still has a blank provider';
  assert (select count(*) from public.vps_hubs where coalesce(provider,'') = '') = 0,
    'vps_hubs still has a blank provider';

  raise notice 'ALL BACKFILL ASSERTIONS PASSED';
end $$;
