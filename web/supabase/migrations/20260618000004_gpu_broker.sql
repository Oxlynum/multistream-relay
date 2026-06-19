-- Track which provider / GPU / datacenter the availability broker landed on.
-- Needed so teardown routes to the correct provider, and for observability into
-- where capacity is actually coming from.
alter table public.gpu_instances
  add column if not exists provider   text not null default 'runpod',
  add column if not exists gpu_type   text,
  add column if not exists datacenter text;
