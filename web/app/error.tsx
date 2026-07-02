"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-error";
import { Button } from "@/components/ui/button";

// Segment error boundary (M13): catches render/runtime errors below the root layout and shows a
// graceful fallback instead of a white screen, and reports the error for capture.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError("app-error", error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="font-pixel text-2xl text-brand crt-chroma">GAME OVER</h1>
      <p className="text-ink-faint max-w-md">
        This page hit an unexpected error. Your stream and account are safe.
      </p>
      <Button onClick={() => reset()}>▶ Continue?</Button>
    </div>
  );
}
