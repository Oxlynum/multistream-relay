import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

// 404 boundary (M13): a friendly, on-brand not-found instead of the bare default.
export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="font-pixel text-xs text-ink-faint">404</p>
      <h1 className="font-pixel text-2xl text-brand crt-chroma">GAME OVER</h1>
      <p className="text-ink-faint max-w-md">No continue on this one — that screen doesn&apos;t exist or has moved.</p>
      <Link href="/" className={buttonVariants()}>
        ▶ Continue
      </Link>
    </div>
  );
}
