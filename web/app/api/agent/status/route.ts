import type { NextRequest } from 'next/server'
import { authenticateAgentDetailed } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { triggerAutoRefill } from '@/app/api/credits/auto-refill/route'
import { teardownInstance, sweepStalePods } from '@/lib/pod-teardown'
import {
  buildBillingContext,
  computeBurnRate,
  type OutputStatus,
  type OutputSettingsMap,
} from '@/lib/billing'

// Never bill more than this many seconds per heartbeat, even if the previous
// heartbeat was long ago (missed beats / restart) — avoids surprise overcharges.
const MAX_BILL_INTERVAL_S = 60

// A pod that's up but not streaming this long is abandoned → destroy it.
const IDLE_GRACE_S = 5 * 60 // 5m

// Agent posts heartbeats here every 10s with live stream status.
export async function POST(request: NextRequest) {
  const authed = await authenticateAgentDetailed(request)
  if (!authed) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { userId, label } = authed
  const isPodAgent = label === 'pod'

  const body = await request.json().catch(() => ({}))
  const { outputs = [], streaming = false } = body as {
    outputs: OutputStatus[]
    streaming: boolean
  }
  const outSummary = outputs.map((o: OutputStatus) => `${o.name}:${o.state}(exit=${o.last_exit ?? '-'},r=${o.restarts ?? 0})`).join(' ')
  console.log(`[agent/status] label=${label} streaming=${streaming} outputs=${outputs.length} ${outSummary}`)

  const supabase = createServerClient()

  const [{ data: instance }, { data: profile }, { data: platforms }] = await Promise.all([
    supabase
      .from('gpu_instances')
      .select('id, last_seen_at, burn_rate, created_at, idle_since, session_id, max_session_at')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('profiles')
      .select('streaming_credits, output_settings, has_2k_addon, landscape_bitrate_kbps, portrait_bitrate_kbps')
      .eq('id', userId)
      .single(),
    // Only needed by the pod agent for billing; skip for dashboard/dock polls.
    isPodAgent
      ? supabase
          .from('platform_connections')
          .select('platform, orientation, enabled')
          .eq('user_id', userId)
      : Promise.resolve({ data: null }),
  ])

  let credits = parseFloat(profile?.streaming_credits ?? '0') || 0
  let burnRate = instance?.burn_rate ?? 0

  const now = Date.now()

  // --- Billing: only the pod agent is the billing clock ---------------------
  if (isPodAgent) {
    const outputSettings: OutputSettingsMap = (profile?.output_settings as OutputSettingsMap) ?? {}
    const has2kAddon = profile?.has_2k_addon ?? false

    const ctx = buildBillingContext(
      (platforms ?? []) as Array<{ platform: string; orientation: string; enabled: boolean }>,
      outputSettings,
      has2kAddon,
      streaming,
    )
    burnRate = computeBurnRate(ctx, streaming)

    const last = instance?.last_seen_at ? new Date(instance.last_seen_at).getTime() : now
    const elapsed = Math.min(Math.max(0, (now - last) / 1000), MAX_BILL_INTERVAL_S)
    const deduct = parseFloat((burnRate * elapsed / 3600).toFixed(3))

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const devBypassId = process.env.SLIMCAST_DEV_NO_BILLING_USER_ID ?? ''
    const devNoBilling =
      !!userId &&
      UUID_RE.test(devBypassId) &&
      devBypassId === userId
    if (devNoBilling) console.log(`[billing] dev bypass active for ${userId} — deduction of ${deduct} tkn skipped`)
    if (deduct > 0 && !devNoBilling) {
      credits = parseFloat(Math.max(0, credits - deduct).toFixed(3))
      await supabase
        .from('profiles')
        .update({ streaming_credits: credits })
        .eq('id', userId)
    }

    const idleSince = streaming
      ? null
      : (instance?.idle_since ?? new Date(now).toISOString())

    // --- Session recording ------------------------------------------------
    let sessionId = instance?.session_id ?? null
    const livePlatforms = Array.from(
      new Set(outputs.flatMap(o => o.platforms ?? []))
    )

    if (streaming && !sessionId) {
      const { data: opened } = await supabase
        .from('stream_sessions')
        .insert({
          user_id: userId,
          started_at: new Date(now).toISOString(),
          duration_seconds: 0,
          credits_deducted: 0,
          platforms: livePlatforms,
        })
        .select('id')
        .single()
      sessionId = opened?.id ?? null
    } else if (streaming && sessionId) {
      const { data: open } = await supabase
        .from('stream_sessions')
        .select('started_at, credits_deducted, platforms')
        .eq('id', sessionId)
        .maybeSingle()
      if (open) {
        const merged = Array.from(new Set([...(open.platforms ?? []), ...livePlatforms]))
        await supabase
          .from('stream_sessions')
          .update({
            duration_seconds: Math.round((now - new Date(open.started_at).getTime()) / 1000),
            credits_deducted: parseFloat(((open.credits_deducted ?? 0) + deduct).toFixed(3)),
            platforms: merged,
          })
          .eq('id', sessionId)
      } else {
        sessionId = null
      }
    } else if (!streaming && sessionId) {
      await supabase
        .from('stream_sessions')
        .update({ ended_at: new Date(now).toISOString() })
        .eq('id', sessionId)
        .is('ended_at', null)
      sessionId = null
    }

    await supabase
      .from('gpu_instances')
      .update({
        last_seen_at: new Date(now).toISOString(),
        burn_rate: burnRate,
        outputs,
        streaming,
        idle_since: idleSince,
        session_id: sessionId,
      })
      .eq('user_id', userId)

    if (streaming && credits < 1.0) {
      const refilled = await triggerAutoRefill(userId)
      if (refilled) {
        const { data: updated } = await supabase
          .from('profiles')
          .select('streaming_credits')
          .eq('id', userId)
          .single()
        credits = parseFloat(updated?.streaming_credits ?? String(credits)) || credits
      }
    }

    // ── Connection metrics: write one inbound + one per active platform ────────
    if (instance?.id) {
      const instanceId = instance.id
      const landscapeBitrate = (profile as { landscape_bitrate_kbps?: number })?.landscape_bitrate_kbps ?? 6000
      const portraitBitrate = (profile as { portrait_bitrate_kbps?: number })?.portrait_bitrate_kbps ?? 4000

      const inboundHealth = streaming ? 100 : 0
      const metricsRows: Array<{
        instance_id: string; user_id: string; direction: string;
        platform: string | null; bitrate_kbps: number | null; health_score: number; dropped_frames: number;
      }> = [
        { instance_id: instanceId, user_id: userId, direction: 'inbound', platform: null,
          bitrate_kbps: null, health_score: inboundHealth, dropped_frames: 0 },
      ]

      for (const o of outputs) {
        const health = o.state === 'running' ? 100 : o.state === 'restarting' ? 50 : 0
        const bitrate = o.mode === 'portrait' ? portraitBitrate : landscapeBitrate
        for (const p of o.platforms ?? []) {
          metricsRows.push({ instance_id: instanceId, user_id: userId, direction: 'outbound',
            platform: p, bitrate_kbps: bitrate, health_score: health, dropped_frames: 0 })
        }
      }

      supabase.from('connection_metrics').insert(metricsRows).then(() => {})
    }

    // ── SAFETY: destroy the pod on any hard condition ───────────────────────
    const idleFor = idleSince ? (now - new Date(idleSince).getTime()) / 1000 : 0
    const maxSessionAt = instance?.max_session_at ? new Date(instance.max_session_at).getTime() : null

    let killReason = ''
    if (credits <= 0) killReason = 'credits_exhausted'
    else if (maxSessionAt && now >= maxSessionAt) killReason = 'session_expired'
    else if (!streaming && idleFor > IDLE_GRACE_S) killReason = 'idle_timeout'

    if (killReason) {
      await teardownInstance(userId, `heartbeat:${killReason}`)
      return Response.json({ command: 'stop', reason: killReason, credits, credits_seconds: Math.round(credits * 3600), burn_rate: 0 })
    }
  }

  if (isPodAgent) sweepStalePods().catch(e => console.error('[sweep] error:', e))

  const { data: cmd } = await supabase
    .from('agent_commands')
    .select('id, command')
    .eq('user_id', userId)
    .is('executed_at', null)
    .order('issued_at', { ascending: true })
    .limit(1)
    .single()

  if (cmd) {
    await supabase
      .from('agent_commands')
      .update({ executed_at: new Date().toISOString() })
      .eq('id', cmd.id)

    return Response.json({ command: cmd.command, credits, credits_seconds: Math.round(credits * 3600), burn_rate: burnRate })
  }

  return Response.json({ command: null, credits, credits_seconds: Math.round(credits * 3600), burn_rate: burnRate, outputs })
}
