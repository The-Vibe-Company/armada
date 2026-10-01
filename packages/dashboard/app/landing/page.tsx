import type { Metadata } from "next";
import { SITE } from "@/components/landing/content";
import { Landing } from "@/components/landing/Landing";
import "./landing.css";

// The public landing (THE-887). Static: built once, it reads no cookie, no
// database, no Linear and no GitHub. The proxy shows it on `/` to a viewer
// without a session; a signed-in member gets the overview there.
export const dynamic = "force-static";

const TITLE = "Armada: run a fleet of coding agents, see every move";
const DESCRIPTION =
  "Armada gives each ticket to one coding agent, puts a coordinator in charge of every project, and shows the whole fleet live, from the first question to the green merge. Open source.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: { type: "website", url: "/", siteName: "Armada", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export default function LandingPage() {
  return <Landing />;
}
