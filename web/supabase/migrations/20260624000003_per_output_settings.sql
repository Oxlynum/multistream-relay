-- Per-output resolution and bitrate settings stored as JSONB on the profile.
-- Structure: { "<platform>": { "resolution": "720p"|"1080p"|"1440p", "bitrate_kbps": number } }
-- Defaults applied in code when a key is missing.
alter table public.profiles
  add column if not exists output_settings jsonb not null default '{}'::jsonb;

-- Gating flag for 1440p (2K) outputs. Set by admin/billing; default false.
alter table public.profiles
  add column if not exists has_2k_addon boolean not null default false;
