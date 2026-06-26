-- Per-pod SRT AES passphrase + per-pod debug-panel password.
--
-- srt_passphrase:  AES passphrase (10–79 chars) that encrypts the OBS→pod HEVC
--   uplink in flight. Set at provision, returned to the OBS plugin via
--   /api/gpu/status (rides in srt_url as &passphrase=...&pbkeylen=16), and
--   required by MediaMTX on the pod (srtReadPassphrase/srtPublishPassphrase) so
--   the secret streamid is no longer the only protection on the public UDP leg.
--
-- panel_password:  per-pod RELAY_PASSWORD for the relay debug panel (:8080),
--   replacing the single shared value. Leaking one pod's panel can no longer
--   reach another's; stored so we can authenticate to the panel for debugging.
--
-- Both are per-pod ephemeral secrets in the same trust domain as ingest_key
-- (service-role only; never selected by browser queries except via srt_url).
alter table gpu_instances
  add column if not exists srt_passphrase text,
  add column if not exists panel_password text;
