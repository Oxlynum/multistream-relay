// Lightweight observability seam (enterprise-audit REL-03). Today this routes errors to a
// single structured console line (greppable + parseable by any Vercel log drain) and fires
// best-effort alerts to an incoming webhook. It is the ONE integration point to later swap
// in Sentry / @vercel/otel without touching call sites — replace the body of captureError.
//
// Hard rule: NOTHING here may throw or block its caller. An observability failure must never
// break the request path. Alerts are fire-and-forget with a hard timeout; if the webhook is
// unset everything is a cheap no-op.

const ALERT_WEBHOOK = process.env.SLIMCAST_ALERT_WEBHOOK ?? ''
const ALERT_TIMEOUT_MS = 4000

// REL-03: Sentry (or any Sentry-compatible endpoint, e.g. GlitchTip) error ingestion. Parse
// the DSN ONCE. Standard shape: <proto>://<publicKey>@<host>/<projectId>. Null (→ every Sentry
// path no-ops) when SENTRY_DSN is unset or malformed, so this is fully INERT until the operator
// pastes a DSN into Vercel — no SDK, no config, no build/runtime dependency added.
const _sentry: { publicKey: string; endpoint: string } | null = (() => {
  const dsn = process.env.SENTRY_DSN ?? ''
  if (!dsn) return null
  try {
    const u = new URL(dsn)
    const projectId = u.pathname.replace(/^\//, '')
    if (!u.username || !projectId) return null
    return { publicKey: u.username, endpoint: `${u.protocol}//${u.host}/api/${projectId}/envelope/` }
  } catch {
    return null
  }
})()

export type AlertFields = Record<string, string | number | boolean | null | undefined>

// Ship ONE error event to Sentry's ingestion (envelope API) — no SDK, just a hard-timeout
// fetch that swallows everything, so it carries zero Next-16/serverless-flush risk and honours
// the never-throw contract. Inert without SENTRY_DSN. This is a LIGHTWEIGHT capture: message +
// exception type + raw stack (in `extra`) + context + tags — NOT parsed code-frames (add
// @sentry/nextjs later if you want the framed stacktrace view). Groups by type + message.
async function sendToSentry(scope: string, error: unknown, ctx: AlertFields): Promise<void> {
  if (!_sentry) return
  // The ENTIRE body is inside the try — the envelope build does JSON.stringify(event) where
  // event.extra spreads the caller's ctx, so a circular/BigInt ctx would throw at build time
  // (before the fetch). Guarding it here keeps the never-throw contract regardless of ctx
  // (mirrors reportServerError guarding its own JSON.stringify console line).
  try {
    const message = error instanceof Error ? error.message : String(error)
    const type = error instanceof Error ? (error.name || 'Error') : 'Error'
    const eventId = crypto.randomUUID().replace(/-/g, '')
    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: 'node',
      level: 'error',
      logger: scope,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'production',
      release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
      tags: { scope },
      exception: { values: [{ type, value: message }] },
      extra: { stack: error instanceof Error ? error.stack : undefined, ...ctx },
    }
    const envelope =
      JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }) + '\n' +
      JSON.stringify({ type: 'event' }) + '\n' +
      JSON.stringify(event)
    await fetch(_sentry.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${_sentry.publicKey}, sentry_client=slimcast/1.0`,
      },
      body: envelope,
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    })
  } catch {
    // never recurse, never throw — an observability failure must not affect the caller.
  }
}

// Structured error capture. Emits one JSON line so a log drain (or a future Sentry shim)
// can parse scope/message/stack/context verbatim. Optionally raises an alert for the paths
// an operator must see immediately (set `alert: true`). Returns void, never throws.
// Awaitable core: structured console line (always) + best-effort Sentry ship + optional alert.
// Never throws. Use where you CAN await the ship to completion — Next's onRequestError (the
// framework awaits it) and any after() context — so the event isn't dropped when a serverless
// invocation ends. console.error runs synchronously (before the first await), so the log line
// is emitted immediately regardless of the async tail.
export async function reportServerError(
  scope: string,
  error: unknown,
  context?: AlertFields & { alert?: boolean },
): Promise<void> {
  const { alert, ...ctx } = context ?? {}
  const message = error instanceof Error ? error.message : String(error)
  try {
    console.error(`[capture] ${JSON.stringify({
      level: 'error', scope, message,
      stack: error instanceof Error ? error.stack : undefined,
      ...ctx, at: new Date().toISOString(),
    })}`)
  } catch {
    // JSON.stringify can throw on a circular context — fall back to a plain line.
    console.error(`[capture] scope=${scope} message=${message}`)
  }
  await sendToSentry(scope, error, ctx)
  if (alert) await sendAlert(`error: ${scope}`, { message, ...ctx })
}

// Structured error capture — SYNC, fire-and-forget (the existing contract: never awaited, never
// throws). Emits the console line synchronously, ships to Sentry + alert in the background. For
// request-path call sites that can't await; where you can await, prefer reportServerError.
export function captureError(
  scope: string,
  error: unknown,
  context?: AlertFields & { alert?: boolean },
): void {
  void reportServerError(scope, error, context)
}

// Best-effort alert to a Slack/Discord-compatible incoming webhook. Inert when
// SLIMCAST_ALERT_WEBHOOK is unset. Hard-timeout + swallow-all so an alerting failure can
// never affect the caller. You MAY await it (e.g. inside a Next after()) or ignore it.
export async function sendAlert(title: string, fields?: AlertFields): Promise<void> {
  if (!ALERT_WEBHOOK) return
  const lines = [
    `*${title}*`,
    ...Object.entries(fields ?? {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `• ${k}: ${v}`),
  ]
  const text = lines.join('\n')
  try {
    await fetch(ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Slack uses {text}; Discord uses {content}. Send both so either endpoint renders it.
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    })
  } catch (e) {
    // Last resort — a single line, and crucially do NOT recurse into sendAlert.
    console.error(`[capture] ${JSON.stringify({
      level: 'warn', scope: 'alert.delivery',
      message: e instanceof Error ? e.message : String(e),
      at: new Date().toISOString(),
    })}`)
  }
}
