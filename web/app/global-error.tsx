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
          background: "#0a0a0f",
          color: "#e6e6ec",
          fontFamily: "system-ui, -apple-system, sans-serif",
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
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Something went wrong</h1>
          <p style={{ color: "#9a9aa5", maxWidth: 440, margin: 0, lineHeight: 1.5 }}>
            An unexpected error broke this page. Your stream and account are unaffected. Try
            again — if it keeps happening, please let us know.
          </p>
          <button
            onClick={() => reset()}
            style={{
              background: "#7c5cfc",
              color: "#fff",
              border: 0,
              borderRadius: 8,
              padding: "10px 18px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
