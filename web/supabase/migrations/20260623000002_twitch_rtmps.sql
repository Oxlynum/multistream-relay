-- Twitch: switch existing rows from plain RTMP (port 1935) to RTMPS (port 443).
-- RunPod community cloud ISPs frequently block outbound port 1935; port 443 is
-- never blocked. rtmps://live.twitch.tv:443/app is Twitch's documented secure ingest.
update public.platform_connections
set rtmp_url = 'rtmps://live.twitch.tv:443/app'
where platform = 'twitch'
  and rtmp_url = 'rtmp://live.twitch.tv/app';
