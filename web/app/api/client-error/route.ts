import { reportServerError } from "@/lib/observability";

// Sink for browser-side error reports (M13). The client error boundaries POST here so client
// crashes flow to the same capture/alert path as server errors (instrumentation.ts onRequestError).
// Always 204 and fully guarded — reporting an error must never produce another. Fields are
// truncated to bound abuse from this unauthenticated endpoint (which is inert anyway until
// SENTRY_DSN is set; add IP rate-limiting here if it ever becomes a spam vector).
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      scope?: string;
      message?: string;
      stack?: string;
      digest?: string;
      url?: string;
    };
    const message = String(body.message ?? "").slice(0, 500);
    if (message) {
      const err = new Error(message);
      err.stack = typeof body.stack === "string" ? body.stack.slice(0, 4000) : undefined;
      void reportServerError(`client.${String(body.scope ?? "error").slice(0, 40)}`, err, {
        digest: body.digest ? String(body.digest).slice(0, 64) : undefined,
        url: body.url ? String(body.url).slice(0, 300) : undefined,
        ua: request.headers.get("user-agent")?.slice(0, 200) ?? undefined,
      });
    }
  } catch {
    /* swallow — the error sink must never 500 */
  }
  return new Response(null, { status: 204 });
}
