import { Skeleton } from "@/components/ui/skeleton";

// Dashboard loading fallback (M13): a skeleton during the initial segment load instead of a blank
// frame (uses the design system's existing Skeleton primitive).
export default function DashboardLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10 space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
