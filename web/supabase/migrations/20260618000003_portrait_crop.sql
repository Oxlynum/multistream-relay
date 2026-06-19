-- Per-account vertical (9:16) framing for the portrait encode group.
-- The GPU crops the landscape source once using these controls, then fans the
-- single cropped feed out to every portrait platform (TikTok / YouTube vertical /
-- Facebook Reels) via the tee muxer.
--
--   portrait_zoom  >= 1.0 : 1.0 uses the full source height; higher zooms in.
--   portrait_pos_x 0..1   : horizontal position of the crop window (0.5 = center).
--   portrait_pos_y 0..1   : vertical position of the crop window (0.5 = center).
alter table public.profiles
  add column if not exists portrait_zoom  real not null default 1.0
    check (portrait_zoom >= 1.0 and portrait_zoom <= 3.0),
  add column if not exists portrait_pos_x real not null default 0.5
    check (portrait_pos_x >= 0.0 and portrait_pos_x <= 1.0),
  add column if not exists portrait_pos_y real not null default 0.5
    check (portrait_pos_y >= 0.0 and portrait_pos_y <= 1.0);
