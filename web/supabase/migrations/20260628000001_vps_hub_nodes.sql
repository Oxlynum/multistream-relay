-- VPS-as-the-Hub — Phase 0 foundations (additive only; prod path unchanged).
--
-- Introduces a `relay_nodes` child table so one streaming session can own TWO
-- physical boxes (a Hetzner VPS hub + a Vast GPU backend) without colliding with
-- gpu_instances' UNIQUE(user_id). gpu_instances stays the per-user SESSION ANCHOR;
-- relay_nodes holds the per-box detail. Nothing here is read by the live broker
-- until SLIMCAST_VPS_HUB is flipped on, so this migration is a no-op for prod.
--
-- Deploy with: supabase db push  (additive — no down-migration needed)

-- ── relay_nodes: one row per physical box in a session ───────────────────────
-- role:
--   'vps_hub'     — Hetzner CPU box: SRT ingest + passthrough delivery + (for
--                   transcode) source-forward to the GPU and platform fan-out.
--   'gpu_backend' — Vast GPU box: NVDEC→NVENC transcode, returns ONE stream per
--                   orientation to the VPS. Never faces a platform.
create table if not exists public.relay_nodes (
  id                   uuid primary key default gen_random_uuid(),
  -- Session anchor. CASCADE so tearing down the gpu_instances row drops its nodes.
  instance_id          uuid not null references public.gpu_instances(id) on delete cascade,
  user_id              uuid not null references public.profiles(id) on delete cascade,
  role                 text not null check (role in ('vps_hub', 'gpu_backend')),
  provider             text not null,                 -- 'hetzner' | 'vast' | ...
  provider_id          text,                          -- provider's own box id (server id / contract id)
  machine_id           text,                          -- host machine id when the provider exposes one (Vast)
  node_key_hash        text,                          -- sha256 of this box's agent key (label 'vps'|'gpu')
  ip_address           text,
  lat                  numeric,
  lon                  numeric,
  -- Ports. On Hetzner container-port == host == public (no remap); on Vast these
  -- are the mapped host ports from getStatus().
  srt_in_port          integer,                       -- OBS → VPS SRT ingest (UDP)
  rtmp_beacon_port     integer,                       -- TCP readiness beacon
  bridge_in_port       integer,                       -- GPU: source ingest from VPS (transcode only)
  bridge_return_port   integer,                       -- VPS: GPU return ingest (transcode only)
  hls_port             integer,                       -- preview (off for passthrough tier)
  -- Lifecycle. `phase` mirrors broker-v2 semantics per-node; `status` is the
  -- coarse state teardown/reaper read.
  status               text,                          -- 'provisioning'|'running'|'ended'|...
  phase                text,                          -- 'requested'|'racing'|'ready'|'streaming'|'ended'
  racers               jsonb not null default '[]'::jsonb,   -- in-flight GPU race entries (gpu_backend only)
  race_round           int not null default 0,
  -- Budget/telemetry (the VPS owns ingress + platform egress; GPU is in-region only).
  cost_usd_hr          numeric,
  egress_gb_hr         numeric,
  ingress_gb_hr        numeric,
  suggested_ingest_kbps integer,
  throttle_tier        text,
  last_seen_at         timestamptz,
  created_at           timestamptz not null default now(),
  -- One box per (session, role): a session has at most one VPS hub and one GPU backend.
  unique (instance_id, role)
);

create index if not exists relay_nodes_instance_idx on public.relay_nodes (instance_id);
create index if not exists relay_nodes_user_idx     on public.relay_nodes (user_id);
create index if not exists relay_nodes_provider_idx on public.relay_nodes (provider, provider_id);

-- RLS: owner-read only. Service-role (broker/agent routes) bypasses RLS for writes.
alter table public.relay_nodes enable row level security;

create policy "Users can read own relay_nodes"
  on public.relay_nodes for select
  using (auth.uid() = user_id);

-- ── gpu_instances: session-level topology (the anchor points at its nodes) ────
alter table public.gpu_instances
  -- 'passthrough_only' = VPS alone, no GPU rented (YouTube / eligible-Twitch).
  -- 'vps_gpu'          = VPS + GPU backend (any transcode output present).
  -- null on legacy rows = today's all-in-one Vast-direct path (unchanged).
  add column if not exists topology      text,
  add column if not exists needs_transcode boolean,
  add column if not exists vps_node_id   uuid references public.relay_nodes(id) on delete set null,
  add column if not exists gpu_node_id   uuid references public.relay_nodes(id) on delete set null,
  -- Shared AES secret for the internal VPS↔GPU bridge legs (source + return).
  add column if not exists bridge_secret text;

-- ── agent_api_keys: widen the label CHECK to admit the two new box roles ──────
-- Additive only — 'pod' is preserved (renaming it would orphan in-flight pods).
alter table public.agent_api_keys drop constraint if exists agent_api_keys_label_check;
alter table public.agent_api_keys
  add constraint agent_api_keys_label_check
  check (label in ('user', 'pod', 'device', 'vps', 'gpu'));

-- Optional direct-resolution hints (so a heartbeat can resolve its node without
-- a hash lookup join). Nullable; unused until the VPS hub path is live.
alter table public.agent_api_keys
  add column if not exists node_role   text,
  add column if not exists instance_id uuid;

-- ── connection_metrics: allow the internal bridge leg as a 3rd direction ──────
alter table public.connection_metrics drop constraint if exists connection_metrics_direction_check;
alter table public.connection_metrics
  add constraint connection_metrics_direction_check
  check (direction in ('inbound', 'outbound', 'bridge'));
