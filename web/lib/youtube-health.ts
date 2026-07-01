// STREAM-02 Stage B: truthful YouTube liveness via the YouTube Data API.
//
// YouTube HLS ingest 200-OKs a dead / unbound / revoked key, so the hub's passthrough
// ffmpeg stays "running" and the dock dot reads GREEN while the stream is actually dead.
// We poll liveStreams.list -> status.healthStatus SERVER-SIDE (the relay has no OAuth
// token, and this must stay OFF the hub heartbeat loop per the audit's STREAM-04/REL-06)
// and cache a verdict on platform_connections that /api/gpu/status overlays onto the
// youtube dot. The full `youtube` OAuth scope we already request grants liveStreams.list
// read, so every connected user is pollable with no re-auth.

import { createServerClient } from '@/lib/supabase'
import { decryptSecret } from '@/lib/crypto'
import { getValidAccessToken } from '@/lib/oauth'

export type YouTubeHealthVerdict = 'live' | 'dead' | 'pending'

// Herd guard: a dock polls /api/gpu/status every 1-5s; without an atomic claim, several
// polls inside one refresh window would each fire a YouTube API call (shared per-project
// quota). A refresh claims the row (stamps checked_at) only if the last check is older
// than this — exactly one concurrent poll wins.
const REFRESH_CLAIM_THROTTLE_S = 15

interface LiveStreamItem {
  cdn?: { ingestionInfo?: { streamName?: string } }
  status?: { streamStatus?: string; healthStatus?: { status?: string } }
}

/**
 * Map ONE liveStreams.list item's status to alive/dead. Pure — unit-testable.
 * healthStatus.status is the authoritative signal:
 *   good / ok / bad -> alive  ('bad' is degraded-but-receiving, NOT dead)
 *   noData / revoked -> dead   (backend receives nothing / key revoked)
 * Falls back to streamStatus ('active' -> alive) only when healthStatus is absent.
 */
export function mapYouTubeHealth(item: LiveStreamItem | undefined): 'alive' | 'dead' {
  const h = item?.status?.healthStatus?.status
  if (h === 'good' || h === 'ok' || h === 'bad') return 'alive'
  if (h === 'noData' || h === 'revoked') return 'dead'
  // No healthStatus present → lean on streamStatus.
  return item?.status?.streamStatus === 'active' ? 'alive' : 'dead'
}

/**
 * Fetch the caller's YouTube liveStream health. Returns 'alive' | 'dead', or null on any
 * error / missing token / no matching stream (caller then leaves the cached verdict as-is).
 * Matches the liveStream by our stored ingest key (streamName); falls back to the first
 * item when there's no exact match.
 */
export async function checkYouTubeHealth(userId: string, streamKey: string | null): Promise<'alive' | 'dead' | null> {
  const accessToken = await getValidAccessToken(userId, 'youtube')
  if (!accessToken) return null

  let res: Response
  try {
    res = await fetch(
      'https://www.googleapis.com/youtube/v3/liveStreams?part=status,cdn&mine=true&maxResults=10',
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) },
    )
  } catch {
    return null // network / timeout → unknown
  }
  if (!res.ok) return null

  const json = (await res.json().catch(() => null)) as { items?: LiveStreamItem[] } | null
  const items = json?.items
  if (!items || items.length === 0) return null

  const match = (streamKey && items.find(i => i.cdn?.ingestionInfo?.streamName === streamKey)) || items[0]
  return mapYouTubeHealth(match)
}

/**
 * Best-effort refresh of the cached YouTube health verdict for a user. Called from
 * /api/gpu/status via after() — never blocks the dock poll, never runs on the heartbeat.
 *
 * Two-strike hysteresis: a single 'dead' reading -> 'pending' (the overlay does NOT error
 * on 'pending', so a stream still warming up right after go-live never flashes red); a
 * second consecutive 'dead' -> 'dead' (overlay -> 'error' dot). Any 'alive' -> 'live'.
 * Claims the row first (herd guard) so concurrent polls fire at most one API call.
 */
export async function refreshYouTubeHealthCache(userId: string): Promise<void> {
  const supabase = createServerClient()
  const throttleBefore = new Date(Date.now() - REFRESH_CLAIM_THROTTLE_S * 1000).toISOString()

  // Atomic claim: stamp checked_at only if no other poll checked within the throttle
  // window (null = never checked → always claimable on first run). If 0 rows match we
  // lost the race (or there's no enabled youtube connection) → bail.
  const { data: claimed } = await supabase
    .from('platform_connections')
    .update({ youtube_health_checked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('platform', 'youtube')
    .eq('enabled', true)
    .or(`youtube_health_checked_at.is.null,youtube_health_checked_at.lt.${throttleBefore}`)
    .select('stream_key_encrypted, youtube_health')
    .maybeSingle()

  if (!claimed) return

  let streamKey: string | null = null
  try {
    streamKey = claimed.stream_key_encrypted ? decryptSecret(claimed.stream_key_encrypted) : null
  } catch {
    streamKey = null // undecryptable key → match falls back to the first live stream
  }

  const reading = await checkYouTubeHealth(userId, streamKey)
  if (reading === null) return // transient/unknown → keep the prior verdict (checked_at already bumped)

  const prev = claimed.youtube_health as YouTubeHealthVerdict | null
  const verdict: YouTubeHealthVerdict =
    reading === 'alive' ? 'live' : prev === 'pending' || prev === 'dead' ? 'dead' : 'pending'

  await supabase
    .from('platform_connections')
    .update({ youtube_health: verdict })
    .eq('user_id', userId)
    .eq('platform', 'youtube')
}
