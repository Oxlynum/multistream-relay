"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-error";
import { Button } from "@/components/ui/button";

// Dashboard-scoped error boundary (M13): a crash in a dashboard page recovers here without taking
// down the whole app, and is reported for capture.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError("dashboard-error", error);
  }, [error]);

  return (
    <div className="min-h-[50vh] flex flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="font-pixel text-xl text-brand crt-chroma">GAME OVER</h1>
      <p className="text-ink-faint max-w-md">
        Something went wrong loading your dashboard. Your stream and account are unaffected.
      </p>
      <Button onClick={() => reset()}>▶ Continue?</Button>
    </div>
  );
}
