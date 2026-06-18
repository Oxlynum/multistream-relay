-- Add streaming credits balance to profiles (2 hr free trial = 7200 seconds)
alter table public.profiles
  add column streaming_credits_seconds integer not null default 7200;

-- Agent API keys: hashed keys used by GPU agent + OBS dock to authenticate.
-- label='user' = dashboard-generated key the user enters in OBS (one per user).
-- label='pod'  = ephemeral key injected into the GPU container at provisioning.
create table public.agent_api_keys (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  key_hash   text not null unique,
  label      text not null default 'user' check (label in ('user', 'pod')),
  created_at timestamptz not null default now()
);

alter table public.agent_api_keys enable row level security;

create policy "Users can read own api keys"
  on public.agent_api_keys for select
  using (auth.uid() = user_id);

create policy "Users can delete own api keys"
  on public.agent_api_keys for delete
  using (auth.uid() = user_id);

-- Platform connections: stream keys per platform per user
create table public.platform_connections (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  platform             text not null check (platform in ('twitch', 'kick', 'youtube', 'tiktok', 'facebook')),
  rtmp_url             text not null,
  stream_key_encrypted text not null,
  bitrate_kbps         integer,
  fps                  integer not null default 60,
  orientation          text not null default 'landscape' check (orientation in ('landscape', 'portrait')),
  enabled              boolean not null default false,
  created_at           timestamptz not null default now(),
  unique (user_id, platform)
);

alter table public.platform_connections enable row level security;

create policy "Users can read own platform connections"
  on public.platform_connections for select
  using (auth.uid() = user_id);

create policy "Users can insert own platform connections"
  on public.platform_connections for insert
  with check (auth.uid() = user_id);

create policy "Users can update own platform connections"
  on public.platform_connections for update
  using (auth.uid() = user_id);

create policy "Users can delete own platform connections"
  on public.platform_connections for delete
  using (auth.uid() = user_id);

-- GPU instances: one cloud compute instance per user (provider is internal)
create table public.gpu_instances (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade unique,
  provider_id    text not null,
  pod_key_hash   text,
  ip_address     text,
  status         text not null default 'provisioning' check (status in ('provisioning', 'running', 'stopped', 'error')),
  last_seen_at   timestamptz,
  created_at     timestamptz not null default now()
);

alter table public.gpu_instances enable row level security;

create policy "Users can read own gpu instances"
  on public.gpu_instances for select
  using (auth.uid() = user_id);

create policy "Users can insert own gpu instances"
  on public.gpu_instances for insert
  with check (auth.uid() = user_id);

create policy "Users can update own gpu instances"
  on public.gpu_instances for update
  using (auth.uid() = user_id);

create policy "Users can delete own gpu instances"
  on public.gpu_instances for delete
  using (auth.uid() = user_id);

-- Stream sessions: history + billing audit trail
create table public.stream_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  duration_seconds  integer,
  credits_deducted  integer,
  platforms         text[] not null default '{}'
);

alter table public.stream_sessions enable row level security;

create policy "Users can read own stream sessions"
  on public.stream_sessions for select
  using (auth.uid() = user_id);

create policy "Users can insert own stream sessions"
  on public.stream_sessions for insert
  with check (auth.uid() = user_id);

create policy "Users can update own stream sessions"
  on public.stream_sessions for update
  using (auth.uid() = user_id);

-- Achievements: badges + credit bonuses
create table public.achievements (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  achievement_key text not null,
  earned_at       timestamptz not null default now(),
  credits_awarded integer not null default 0,
  unique (user_id, achievement_key)
);

alter table public.achievements enable row level security;

create policy "Users can read own achievements"
  on public.achievements for select
  using (auth.uid() = user_id);

-- Pending control commands from dashboard/dock → GPU agent
create table public.agent_commands (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  command     text not null check (command in ('start', 'stop')),
  issued_at   timestamptz not null default now(),
  executed_at timestamptz
);

alter table public.agent_commands enable row level security;

create policy "Users can read own agent commands"
  on public.agent_commands for select
  using (auth.uid() = user_id);

create policy "Users can insert own agent commands"
  on public.agent_commands for insert
  with check (auth.uid() = user_id);

create policy "Users can update own agent commands"
  on public.agent_commands for update
  using (auth.uid() = user_id);

-- Updated handle_new_user: also generate an API key on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  new_key       text;
  raw_api_key   text;
begin
  -- License key in format SC-XXXX-XXXX-XXXX-XXXX
  new_key := 'SC-'
    || upper(substring(encode(gen_random_bytes(4), 'hex') for 4))
    || '-'
    || upper(substring(encode(gen_random_bytes(4), 'hex') for 4))
    || '-'
    || upper(substring(encode(gen_random_bytes(4), 'hex') for 4))
    || '-'
    || upper(substring(encode(gen_random_bytes(4), 'hex') for 4));

  -- Raw API key: 32 random hex bytes. The plaintext is shown to the user once;
  -- only the SHA-256 hash is stored. We store the prefix for display.
  raw_api_key := encode(gen_random_bytes(32), 'hex');

  insert into public.profiles (id, email, tier, streaming_credits_seconds)
  values (new.id, new.email, 'free', 7200);

  insert into public.license_keys (user_id, key, tier)
  values (new.id, new_key, 'free');

  -- Store hashed API key. The route that creates the user must return the raw key
  -- from the API response immediately after signup — it cannot be recovered later.
  insert into public.agent_api_keys (user_id, key_hash)
  values (new.id, encode(digest(raw_api_key, 'sha256'), 'hex'));

  return new;
end;
$$;
