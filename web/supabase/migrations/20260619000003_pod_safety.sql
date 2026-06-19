-- Records when a pod last transitioned to non-streaming (NULL while streaming).
-- The heartbeat and the cron reaper use this to destroy pods that sit idle (OBS
-- crashed, user walked away) so a rogue pod can never keep billing RunPod.
alter table public.gpu_instances
  add column if not exists idle_since timestamptz;
