import { SpeedInsights } from "@vercel/speed-insights/next";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import { GeistMono } from "./fonts";
import "./globals.css";

// The browser's chrome takes the dashboard's background (`--bg` in globals.css).
export const viewport: Viewport = { themeColor: "#09090b" };

// Static, so the landing (THE-887) is prerendered: no cookie is read here. The
// pages that read the language cookie set their title and `<html lang>`
// themselves (components/DocumentLanguage.tsx); the landing opens itself to search engines.
export const metadata: Metadata = {
  title: "Armada",
  description: "Armada: the live fleet of every registered project.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // DocumentLanguage may change `lang` before React hydrates.
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body>
        {children}
        {/* Real page speed from viewers' browsers (THE-853); a no-op outside Vercel. */}
        <SpeedInsights />
      </body>
    </html>
  );
}
