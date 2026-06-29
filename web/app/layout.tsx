import type { Metadata } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const display = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const sans = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

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
      className={`dark ${display.variable} ${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-bg text-ink">
        <TooltipProvider delay={150}>{children}</TooltipProvider>
        <Toaster />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
