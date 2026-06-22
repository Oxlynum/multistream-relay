-- Device linking (OAuth-style Authorization Code + PKCE, brokered by our app).
-- The OBS plugin opens the browser to /link; after the user authorizes, the
-- browser redirects to the plugin's loopback with a one-time code, which the
-- plugin exchanges (proving possession of the PKCE verifier) for a per-device
-- agent key. No key is ever displayed or pasted.

create table if not exists public.device_link_codes (
  code_hash      text primary key,          -- sha256(one-time auth code)
  user_id        uuid not null references public.profiles(id) on delete cascade,
  code_challenge text not null,             -- base64url(sha256(verifier)), PKCE S256
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  consumed       boolean not null default false
);

alter table public.device_link_codes enable row level security;
-- No policies: service-role only (the anon/auth client never touches this).

-- Per-device keys are a first-class label alongside the dashboard 'user' key and
-- the ephemeral 'pod' key, so a device can be revoked without nuking the others.
alter table public.agent_api_keys drop constraint if exists agent_api_keys_label_check;
alter table public.agent_api_keys
  add constraint agent_api_keys_label_check check (label in ('user', 'pod', 'device'));

-- Optional friendly name + last-seen for a future "linked devices" dashboard.
alter table public.agent_api_keys add column if not exists device_name text;
alter table public.agent_api_keys add column if not exists last_used_at timestamptz;
