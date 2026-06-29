-- Primary platform: the user's headline destination (UI label + future hub-placement hint
-- for the VPS plan; consumed there, NOT by the GPU broker). Nullable; NULL = no explicit
-- primary. CHECK mirrors KNOWN_PLATFORMS in app/api/output-settings/route.ts.
-- Additive + idempotent + convergent.
alter table public.profiles
  add column if not exists primary_platform text;

alter table public.profiles drop constraint if exists profiles_primary_platform_check;
alter table public.profiles
  add constraint profiles_primary_platform_check
  check (primary_platform is null or primary_platform in ('twitch','youtube','kick','tiktok'));
