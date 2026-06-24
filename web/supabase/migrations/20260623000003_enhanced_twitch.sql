-- Enhanced Twitch: relay encodes three quality tiers (1080p60, 720p60, 480p30)
-- and sends them as separate RTMP connections to Twitch's multitrack ingest.
-- Costs +0.3 tokens/hr when the enhanced runner is live.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS enhanced_twitch BOOLEAN NOT NULL DEFAULT FALSE;
