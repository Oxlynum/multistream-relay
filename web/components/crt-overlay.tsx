/**
 * Full-screen CRT effect layer — mounted once in the root layout <body>.
 * Fixed + pointer-events-none so it never intercepts clicks. Layers:
 *   .crt-lines  — scanlines (toggled by `.crt-scanlines` on <html>)
 *   .crt-bar    — slow-moving refresh band (motion; auto-off for reduced-motion)
 *   ::before    — vignette + subtle screen curvature (always on)
 * All styling lives in app/globals.css @layer utilities.
 */
export function CrtOverlay() {
  return (
    <div className="crt-screen" aria-hidden="true">
      <div className="crt-lines" />
      <div className="crt-bar" />
    </div>
  )
}
