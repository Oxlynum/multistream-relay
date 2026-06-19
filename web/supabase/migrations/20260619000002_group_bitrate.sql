-- Per-encode-group bitrate caps. The GPU encodes once per orientation and tees
-- the result to every platform in that group, so bitrate is a property of the
-- group, not the platform. These two caps drive the landscape encode (Twitch/
-- Kick) and the portrait encode (TikTok / any portrait platform). YouTube
-- landscape is HEVC passthrough and ignores these.
alter table public.profiles
  add column if not exists landscape_bitrate_kbps integer not null default 6000;
alter table public.profiles
  add column if not exists portrait_bitrate_kbps integer not null default 4000;
