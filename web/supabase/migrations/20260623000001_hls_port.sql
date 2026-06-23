-- Store the RunPod-mapped public port for the HLS preview server (internal :8888).
-- The port is random per pod, so we capture it at provision time alongside ingest_port.
alter table public.gpu_instances
  add column if not exists hls_port integer;
