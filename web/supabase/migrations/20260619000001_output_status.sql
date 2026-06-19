-- Live per-platform output state, written by the pod agent's heartbeat so the
-- dashboard + OBS plugin can render real status dots (Twitch live, TikTok idle,
-- …) without polling the GPU directly. Mirrors supervisor.status():
--   [{ "name": "landscape", "state": "running", "mode": "landscape",
--      "platforms": ["twitch","kick"] }, …]
alter table public.gpu_instances
  add column if not exists outputs jsonb not null default '[]'::jsonb;

-- Whether the pod currently has at least one output running. Distinct from
-- status='running' (the pod is up) — streaming means OBS is actually pushing.
alter table public.gpu_instances
  add column if not exists streaming boolean not null default false;
