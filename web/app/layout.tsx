import type { Metadata } from "next";
import { Press_Start_2P, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { CrtOverlay } from "@/components/crt-overlay";
import "./globals.css";

// Runs before first paint: apply the saved scanline preference (default ON) to
// <html> so there's no flash and no hydration mismatch on the toggled class.
const SCANLINE_INIT = `(function(){try{var v=localStorage.getItem('slimcast-scanlines');if(v===null||v==='1')document.documentElement.classList.add('crt-scanlines');}catch(e){document.documentElement.classList.add('crt-scanlines');}})();`;

// Pixel display font for short/big text (hero words, logo, buttons, kickers).
const display = Press_Start_2P({
  variable: "--font-press-start",
  subsets: ["latin"],
  weight: ["400"],
});

// Terminal mono carries all body/data/headings.
const mono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://slimcast.io"),
  title: {
    default: "SlimCast — One stream up. Every platform live.",
    template: "%s · SlimCast",
  },
  description:
    "Push one HEVC stream from OBS and go live on Twitch, YouTube, Kick, and TikTok at once. Cloud GPU transcoding, no second PC, no terminal. Free during early access.",
  keywords: [
    "multistream", "OBS multistream", "stream to Twitch and YouTube",
    "HEVC streaming", "restream alternative", "multistreaming for creators",
  ],
  openGraph: {
    title: "SlimCast — One stream up. Every platform live.",
    description:
      "Multistream infrastructure for creators. One HEVC feed from OBS, live on four platforms, on a cloud GPU that only exists while you're streaming.",
    url: "https://slimcast.io",
    siteName: "SlimCast",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SlimCast — One stream up. Every platform live.",
    description: "One HEVC feed from OBS, live on four platforms at once. Free during early access.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      suppressHydrationWarning
      className={`dark ${display.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-bg text-ink">
        <script dangerouslySetInnerHTML={{ __html: SCANLINE_INIT }} />
        <TooltipProvider delay={150}>{children}</TooltipProvider>
        <Toaster />
        <CrtOverlay />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
