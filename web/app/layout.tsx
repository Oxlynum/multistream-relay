import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://slimcast-oxlynum.vercel.app"),
  title: {
    default: "SlimCast — One stream in. Every platform live.",
    template: "%s · SlimCast",
  },
  description:
    "Push one HEVC stream from OBS and go live on Twitch, YouTube, Kick, and TikTok at once. Cloud GPU transcoding, pay-per-second, no setup.",
  keywords: [
    "multistream", "OBS multistream", "stream to Twitch and YouTube",
    "HEVC streaming", "restream alternative", "multistreaming for creators",
  ],
  openGraph: {
    title: "SlimCast — One stream in. Every platform live.",
    description:
      "Multistream infrastructure for creators. One HEVC feed from OBS, live everywhere, billed by the second.",
    url: "https://slimcast-oxlynum.vercel.app",
    siteName: "SlimCast",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SlimCast — One stream in. Every platform live.",
    description: "One HEVC feed from OBS, live on five platforms. Pay-per-second, no setup.",
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
