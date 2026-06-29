-- Provider universality (termination-system-plan Phase 2, item 1): kill "blank = Vast".
--
-- getProvider()/getVpsProvider() are now STRICT — a blank/null/unknown provider name
-- THROWS instead of silently resolving to Vast (which routed a non-Vast box's destroy to
-- the wrong API → no-op → the box billed forever). Every box now stamps its provider AT
-- CREATE (provision route, vps-broker onRacerCreated). This migration converts the only
-- legitimate remaining blanks — legacy rows that predate the provider column — into the
-- explicit value they always were, so the new strict resolver never trips on real data.
--
-- WHY each backfill value is correct:
--   * gpu_instances: column DEFAULT is already 'vast'; a blank here is a pre-default
--     legacy row, and every all-in-one pod that ever existed was Vast (RunPod is
--     backend-only and never ingested). So blank → 'vast' is exact, not a guess.
--   * relay_nodes (gpu_backend): can be Vast OR RunPod, so we CANNOT assume 'vast'. We
--     recover the true provider from the row's own racers[] (the sole N=1 racer carries
--     it). A blank row with NO racer has no box to route anyway (provider_id is null);
--     it is left blank and the name-prefix orphan reconcile remains its backstop.
--   * vps_hubs: getVpsProvider was already strict, so any live hub already carries a
--     valid provider; Hetzner is the only VPS provider historically, so a defensive
--     blank → 'hetzner' backfill is exact.
--
-- Additive, idempotent, convergent on BOTH a fresh history replay AND the live schema
-- (every UPDATE is guarded on the blank predicate → re-running is a no-op).

-- ── 1. gpu_instances: legacy blanks are all Vast ─────────────────────────────────────
update public.gpu_instances
set provider = 'vast'
where provider is null or provider = '';

-- ── 2. relay_nodes gpu_backend: recover provider from the row's own racer ────────────
-- racers is a jsonb array of { provider, provider_id, state, ... }; the backend race is
-- N=1, so racers->0->>'provider' is the box's true provider. Only touch blank rows that
-- actually have a racer to recover from.
update public.relay_nodes
set provider = racers->0->>'provider'
where (provider is null or provider = '')
  and jsonb_typeof(racers) = 'array'
  and jsonb_array_length(racers) >= 1
  and coalesce(racers->0->>'provider', '') <> '';

-- ── 3. vps_hubs: defensive — Hetzner is the only historical VPS provider ─────────────
update public.vps_hubs
set provider = 'hetzner'
where provider is null or provider = '';
