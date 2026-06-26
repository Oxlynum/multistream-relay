-- SRT-only + Vast-only migration.
--
-- SRT (UDP) is now the ONLY OBS→pod ingest transport, so the srt_enabled toggle is
-- gone — it's implicitly always on. RunPod was removed as a provider (its pods are
-- TCP-only and can't carry SRT), leaving Vast.ai as the sole provider, so the
-- provider column now defaults to 'vast'.
--
-- NOTE: gpu_instances.srt_port is KEPT — it's the pod's host-mapped SRT ingest port
-- and is now used on every pod, not just opt-in ones.

-- The SRT toggle is no longer a user choice; SRT is always used. Billing folds it
-- into the base rate (the +0.1 surcharge was removed in lib/billing.ts).
alter table profiles
  drop column if exists srt_enabled;

-- Vast is the only provider now. Flip the default so new rows are stamped 'vast'.
alter table gpu_instances
  alter column provider set default 'vast';

-- Migrate any legacy 'runpod' rows so teardown's getProvider() never resolves a
-- now-deleted provider. (A stale row's Vast destroy harmlessly no-ops on the
-- unknown id, then the row is deleted — the desired cleanup.) Any RunPod pod that
-- is genuinely still running must be destroyed manually via RunPod — nothing in the
-- codebase can reap it once the RunPod provider is gone.
update gpu_instances
  set provider = 'vast'
  where provider = 'runpod';
