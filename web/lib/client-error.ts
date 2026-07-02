// Client-side error reporter (M13). Browser error boundaries call this so client render crashes
// reach the same Sentry/alert seam as server errors (instrumentation.ts onRequestError). Fully
// guarded + fire-and-forget — reporting must NEVER throw (that would re-trip the very boundary
// that called it). Inert in effect until SENTRY_DSN is set server-side.
export function reportClientError(
  scope: string,
  error: (Error & { digest?: string }) | null | undefined,
  extra?: Record<string, string | number | undefined>,
): void {
  try {
    const payload = {
      scope,
      message: (error?.message ?? "unknown").slice(0, 500),
      stack: error?.stack?.slice(0, 4000),
      digest: error?.digest,
      url: typeof location !== "undefined" ? location.href : undefined,
      ...extra,
    };
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never let error reporting cause an error */
  }
}
