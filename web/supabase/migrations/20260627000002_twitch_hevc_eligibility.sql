-- Twitch HEVC / Enhanced Broadcasting eligibility, detected via
-- GetClientConfiguration (lib/twitch-eligibility.ts). Only HEVC-eligible channels
-- (Partner / select Affiliate, 2K tier) can use eRTMP HEVC passthrough + 1440p to
-- Twitch; everyone else is H.264 transcode at <=1080p. These columns drive both
-- the agent routing (mode: 'ertmp' vs 'transcode') and which options the dashboard
-- / OBS dock expose. Twitch-specific, so meaningful only on the platform='twitch'
-- row; null/default elsewhere is harmless.

alter table public.platform_connections
  add column if not exists twitch_hevc_eligible boolean not null default false,
  -- User's choice to use HEVC passthrough when eligible. Defaults on; ignored
  -- (and unsettable in the UI) unless twitch_hevc_eligible is true.
  add column if not exists twitch_use_passthrough boolean not null default true,
  -- Max resolution Twitch authorizes for this channel (px height): 1080 or 1440.
  add column if not exists twitch_max_height int not null default 1080,
  -- When eligibility was last checked, so the app can re-probe periodically.
  add column if not exists twitch_eligibility_checked_at timestamptz;
