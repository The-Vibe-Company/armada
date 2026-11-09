import type { Metadata, Viewport } from "next";
import { SITE } from "@/components/landing/content";
import { Landing } from "@/components/landing/Landing";
import { geist, geistMono } from "./fonts";
import "./landing.css";

// The public landing (THE-887), restored from armada-v1-final by #564 with its
// words brought to Armada v2. It reads no cookie, no session, no database and
// no provider. The proxy shows it on `/` to a viewer without a session, and a
// signed-in member's `/` is the dashboard: the same URL answers differently by
// cookie. So it renders on each request, sent `no-store` (v1 prerendered it with
// a year's `s-maxage`, which a cache keyed on the URL alone would serve to a
// member). The root page's redirect is dynamic for the same reason.
export const dynamic = "force-dynamic";

const TITLE = "Armada: run a fleet of coding agents, see every move";
const DESCRIPTION =
  "Armada launches Claude Code and Codex in sandboxes built from your repositories, for you or for the agent that orchestrates your work, and shows every session live. Open source.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  // The whole title: the app's "%s · Armada" template would repeat the name.
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: { type: "website", url: "/", siteName: "Armada", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

// The browser's chrome takes the landing's night (v1's theme color).
export const viewport: Viewport = { themeColor: "#09090b" };

export default function LandingPage() {
  return (
    <div className={`${geist.variable} ${geistMono.variable}`}>
      <Landing />
    </div>
  );
}
