-- Path A correctness + security:
--   ingest_port: RunPod maps the pod's internal 1935 to a RANDOM public port.
--     We were hardcoding :1935 (nothing listens there) — store the real mapped
--     port so OBS connects to rtmp://<ip>:<ingest_port>.
--   ingest_key: a per-pod random secret used as the RTMP path, so only OBS with
--     this key can publish to the pod (the old fixed "live" path was an open
--     ingest on a public port).
alter table public.gpu_instances
  add column if not exists ingest_port integer,
  add column if not exists ingest_key  text;
