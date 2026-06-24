-- OAuth tokens for platform connections.
-- Access/refresh tokens are encrypted with AES-256-GCM via encryptSecret()
-- (same key as stream_key_encrypted) so a DB dump alone is ciphertext.
create table public.platform_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  platform      text not null check (platform in ('twitch', 'kick', 'youtube', 'tiktok', 'facebook')),
  access_token  text not null,   -- AES-256-GCM encrypted
  refresh_token text,            -- AES-256-GCM encrypted, null if platform doesn't issue one
  expires_at    timestamptz,     -- null = doesn't expire (e.g. Twitch with long-lived token)
  scope         text,
  connected_at  timestamptz not null default now(),
  unique (user_id, platform)
);

alter table public.platform_tokens enable row level security;

-- Users can read their own token rows (to check connected status).
-- Actual token values are never selected by client-side queries — only
-- service-role API routes read/write access_token/refresh_token columns.
create policy "Users can read own platform tokens"
  on public.platform_tokens for select
  using (auth.uid() = user_id);

create policy "Users can delete own platform tokens"
  on public.platform_tokens for delete
  using (auth.uid() = user_id);

-- Flag on platform_connections so the UI knows whether a connection was
-- created via OAuth (auto-fetched key) or manual paste. Service-role only
-- writes this; users can read it through the existing SELECT policy.
alter table public.platform_connections
  add column if not exists oauth_connected boolean not null default false;
