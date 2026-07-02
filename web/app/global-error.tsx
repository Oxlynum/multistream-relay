"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-error";

// Root error boundary (M13): catches errors thrown in the ROOT layout itself, which the segment
// error.tsx cannot. It REPLACES the whole document, so it renders its own <html>/<body> and uses
// inline styles — no dependency on globals.css or component imports, which may be what broke.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError("global-error", error);
  }, [error]);

  return (
    <html lang="en" className="dark">
      <body
        style={{
          margin: 0,
          background: "#050505",
          color: "#eaffd6",
          fontFamily: "ui-monospace, 'JetBrains Mono', 'SF Mono', monospace",
        }}
      >
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            padding: 24,
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: 1, margin: 0, textTransform: "uppercase" }}>
            Game Over
          </h1>
          <p style={{ color: "#8fae6e", maxWidth: 440, margin: 0, lineHeight: 1.5 }}>
            An unexpected error broke this page. Your stream and account are unaffected. Hit
            continue — if it keeps happening, please let us know.
          </p>
          <button
            onClick={() => reset()}
            style={{
              background: "#a3f000",
              color: "#0a0f00",
              border: "2px solid #a3f000",
              borderRadius: 0,
              padding: "10px 18px",
              fontSize: 14,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 1,
              cursor: "pointer",
            }}
          >
            Continue?
          </button>
        </div>
      </body>
    </html>
  );
}
