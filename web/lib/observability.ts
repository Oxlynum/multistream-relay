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

export type AlertFields = Record<string, string | number | boolean | null | undefined>

// Structured error capture. Emits one JSON line so a log drain (or a future Sentry shim)
// can parse scope/message/stack/context verbatim. Optionally raises an alert for the paths
// an operator must see immediately (set `alert: true`). Returns void, never throws.
export function captureError(
  scope: string,
  error: unknown,
  context?: AlertFields & { alert?: boolean },
): void {
  const { alert, ...ctx } = context ?? {}
  const message = error instanceof Error ? error.message : String(error)
  try {
    console.error(`[capture] ${JSON.stringify({
      level: 'error',
      scope,
      message,
      stack: error instanceof Error ? error.stack : undefined,
      ...ctx,
      at: new Date().toISOString(),
    })}`)
  } catch {
    // JSON.stringify can throw on a circular context — fall back to a plain line.
    console.error(`[capture] scope=${scope} message=${message}`)
  }
  if (alert) {
    // Don't await — captureError is sync by contract. The promise self-handles errors.
    void sendAlert(`error: ${scope}`, { message, ...ctx })
  }
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
