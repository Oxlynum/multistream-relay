import type { Instrumentation } from 'next'

// REL-03 observability. Funnel EVERY unhandled server error (route handlers, Server Component
// renders, Server Actions) through the shared observability seam → Sentry (when SENTRY_DSN is
// set) + a structured console line. This complements the explicit captureError() call sites —
// it catches crashes that never reach one. Next-native (onRequestError, stable since Next 15),
// so no SDK/config/next.config wrap is added. The framework AWAITS this hook, so the Sentry
// ship completes before the invocation ends (no dropped events). observability.ts uses only
// cross-runtime APIs (fetch / crypto / URL), so this is safe in both the Node and Edge runtime.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { reportServerError } = await import('@/lib/observability')
  await reportServerError('next.onRequestError', err, {
    path: request.path,
    method: request.method,
    router_kind: context.routerKind,
    route_path: context.routePath,
    route_type: context.routeType,
  })
}
