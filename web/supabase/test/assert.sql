-- Regression guard for the deny-by-default lockdown (20260701000002). Run after the full
-- migration chain in CI (and locally). Asserts the money/limiter RPCs and secret tables are
-- server-only, and that the browser roles KEEP the SELECTs the dashboard actually uses.
do $$
begin
  -- Money/limiter RPCs: browser roles must NOT execute them (C1, H1, M1).
  assert not has_function_privilege('anon','public.deduct_tokens(uuid,numeric)','execute'),
    'FAIL: anon can execute deduct_tokens';
  assert not has_function_privilege('authenticated','public.deduct_tokens(uuid,numeric)','execute'),
    'FAIL: authenticated can execute deduct_tokens';
  assert not has_function_privilege('anon','public.grant_subscription_allotment(text,uuid,numeric,numeric)','execute'),
    'FAIL: anon can execute grant_subscription_allotment';
  assert not has_function_privilege('authenticated','public.grant_subscription_allotment(text,uuid,numeric,numeric)','execute'),
    'FAIL: authenticated can execute grant_subscription_allotment';
  assert not has_function_privilege('anon','public.rate_limit_hit(text,integer,integer)','execute'),
    'FAIL: anon can execute rate_limit_hit';

  -- The server role MUST retain execute (else every RPC breaks).
  assert has_function_privilege('service_role','public.deduct_tokens(uuid,numeric)','execute'),
    'FAIL: service_role lost deduct_tokens execute';
  assert has_function_privilege('service_role','public.grant_subscription_allotment(text,uuid,numeric,numeric)','execute'),
    'FAIL: service_role lost grant_subscription_allotment execute';

  -- Sensitive tables: browser roles must NOT insert/delete (H3).
  assert not has_table_privilege('authenticated','public.platform_connections','insert'),
    'FAIL: authenticated can insert platform_connections';
  assert not has_table_privilege('authenticated','public.platform_connections','delete'),
    'FAIL: authenticated can delete platform_connections';
  assert not has_table_privilege('authenticated','public.gpu_instances','insert'),
    'FAIL: authenticated can insert gpu_instances';
  assert not has_table_privilege('authenticated','public.gpu_instances','delete'),
    'FAIL: authenticated can delete gpu_instances';

  -- Secret-bearing tables: browser roles must NOT even SELECT (M22).
  assert not has_table_privilege('anon','public.gpu_instances','select'),
    'FAIL: anon can select gpu_instances (bridge_secret/srt_passphrase leak)';
  assert not has_table_privilege('authenticated','public.gpu_instances','select'),
    'FAIL: authenticated can select gpu_instances (bridge_secret/srt_passphrase leak)';
  assert not has_table_privilege('authenticated','public.relay_nodes','select'),
    'FAIL: authenticated can select relay_nodes';
  assert not has_table_privilege('authenticated','public.vps_hubs','select'),
    'FAIL: authenticated can select vps_hubs';

  -- Dashboard reads MUST still work (SELECT preserved on the tables the browser reads).
  assert has_table_privilege('authenticated','public.platform_connections','select'),
    'FAIL: authenticated lost platform_connections select (dashboard breaks)';
  assert has_table_privilege('authenticated','public.stream_sessions','select'),
    'FAIL: authenticated lost stream_sessions select (history breaks)';
  assert has_table_privilege('authenticated','public.profiles','select'),
    'FAIL: authenticated lost profiles select';

  raise notice 'ALL LOCKDOWN ASSERTIONS PASSED';
end $$;
