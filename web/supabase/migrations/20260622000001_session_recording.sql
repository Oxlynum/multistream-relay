-- Session recording: the heartbeat (the billing clock) opens a stream_sessions
-- row on the first streaming beat, accumulates duration/credits/platforms each
-- beat, and closes it when streaming stops or the pod is torn down. This column
-- tracks the pod's currently-open session so successive heartbeats update the
-- same row. ON DELETE SET NULL: deleting old history never orphans a live pod.
alter table public.gpu_instances
  add column session_id uuid references public.stream_sessions(id) on delete set null;
