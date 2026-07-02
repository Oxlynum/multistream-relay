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
    default: "SlimCast — Stream anywhere. Go live everywhere.",
    template: "%s · SlimCast",
  },
  description:
    "Stream smooth even on bad WiFi or a hotspot — up to 8% packet loss with no drops or buffering — and go live on Twitch, YouTube, Kick, and TikTok at once. 1080p60 now, 1440p soon. Free during early access.",
  keywords: [
    "multistream", "stream on bad wifi", "stream to Twitch and YouTube",
    "streaming with packet loss", "restream alternative", "multistreaming for creators",
  ],
  openGraph: {
    title: "SlimCast — Stream anywhere. Go live everywhere.",
    description:
      "Rock-solid streaming for creators on real-world internet. Push through the connection drops that freeze everyone else, and go live on every platform at once.",
    url: "https://slimcast.io",
    siteName: "SlimCast",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SlimCast — Stream anywhere. Go live everywhere.",
    description: "Stream through bad WiFi and go live on Twitch, YouTube, Kick & TikTok at once. Free during early access.",
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
