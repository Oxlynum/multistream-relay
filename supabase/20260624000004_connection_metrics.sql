CREATE TABLE connection_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid REFERENCES gpu_instances(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  recorded_at timestamptz DEFAULT now(),
  direction text NOT NULL, -- 'inbound' | 'outbound'
  platform text, -- null for inbound, 'twitch'/'youtube'/etc for outbound
  bitrate_kbps integer,
  health_score integer, -- 0-100
  dropped_frames integer DEFAULT 0
);

CREATE INDEX ON connection_metrics (instance_id, direction, recorded_at DESC);
CREATE INDEX ON connection_metrics (user_id, direction, recorded_at DESC);

-- auto-purge rows older than 2 hours
CREATE OR REPLACE FUNCTION purge_old_metrics() RETURNS void LANGUAGE sql AS $$
  DELETE FROM connection_metrics WHERE recorded_at < now() - interval '2 hours';
$$;

-- RLS: users only see their own metrics
ALTER TABLE connection_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can read own metrics"
  ON connection_metrics FOR SELECT
  USING (auth.uid() = user_id);

-- Service role (used by API routes) bypasses RLS
