import { SpeedInsights } from "@vercel/speed-insights/next";
import type { Metadata, Viewport } from "next";
import { geist, geistFull, geistMono, geistMonoFull } from "./fonts/geist";
import "./globals.css";

// Geist and Geist Mono (THE-889): every page preloads their Latin cut; the full
// fonts load only for a character outside it (app/fonts/geist.ts, `bun run fonts`).
const FONTS = [geist, geistFull, geistMono, geistMonoFull].map((font) => font.variable).join(" ");

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
    <html lang="en" className={FONTS} suppressHydrationWarning>
      <body>
        {children}
        {/* Real page speed from viewers' browsers (THE-853); a no-op outside Vercel. */}
        <SpeedInsights />
      </body>
    </html>
  );
}
