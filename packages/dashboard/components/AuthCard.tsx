// The frame of the pages before the shell (sign in, welcome, a terminal's
// code, an invitation), in the v4 look: centered, the Armada mark over one
// card, no sidebar. The card's heading is the page's one h1, since these
// pages have no header bar. Their forms use the page kit's controls.

import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "./shell/Logo";

export function AuthCard({
  kicker,
  heading,
  lead,
  children,
}: {
  kicker?: string;
  heading: string;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="au">
      <div className="au-column">
        <Link href="/" className="au-brand">
          <Logo size={22} />
          Armada
        </Link>
        <div className="au-card">
          {kicker && kicker !== heading && <div className="au-kicker">{kicker}</div>}
          <h1 className="au-heading">{heading}</h1>
          {lead && <p className="au-lead">{lead}</p>}
          {children}
        </div>
      </div>
    </main>
  );
}

/** A line on top of the card's form: a refusal, or a step done. */
export function AuthNotice({ tone, id, children }: { tone: "critical" | "done"; id?: string; children: ReactNode }) {
  return (
    <p id={id} className={`au-notice is-${tone}`} role={tone === "critical" ? "alert" : "status"}>
      {children}
    </p>
  );
}
