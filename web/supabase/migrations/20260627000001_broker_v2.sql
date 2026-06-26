-- Broker v2: push-readiness state machine + parallel race.
-- Additive only — existing columns and the v1 broker path are unchanged.
-- Deploy with: supabase db push

alter table gpu_instances
  -- Fine-grained provisioning phase. Maps to existing status for backward compat:
  --   'requested' / 'racing' → status='provisioning'
  --   'ready' / 'streaming'  → status='running'
  -- v1 broker ignores this column; v2 reads it.
  add column if not exists phase text,

  -- In-flight racer pods for the parallel race. Each element:
  --   { provider, provider_id, state: 'booting'|'ready'|'failed'|'loser', machine_id? }
  -- Populated at provision (before any readiness probe) so every racer is reapable
  -- from this one row even if the function is killed mid-fan-out.
  -- The winner's provider_id is promoted to the top-level column (teardown reads that).
  add column if not exists racers jsonb not null default '[]'::jsonb,

  -- Guards the "kick next round" path in /api/agent/failed against duplicate POSTs.
  -- CAS-incremented when transitioning rounds; only the transition that wins the
  -- increment fans out the next N pods.
  add column if not exists race_round int not null default 0,

  -- User geo saved at provision time so /api/agent/failed can rank the next round
  -- without needing geo headers (which aren't available in that path).
  add column if not exists provision_lat numeric,
  add column if not exists provision_lon numeric;
