// The frame of the pages around the fleet (sign in, welcome, invitation): the
// brand, a kicker, a heading and a lead, then the page's own content.

import Link from "next/link";
import type { ReactNode } from "react";

export function AuthCard({
  brandSub,
  kicker,
  heading,
  lead,
  wide = false,
  children,
}: {
  brandSub: string;
  kicker: string;
  heading: string;
  lead?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <main className="login">
      <div className={`login-card${wide ? " is-wide" : ""}`}>
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden />
          Armada <small>{brandSub}</small>
        </Link>
        <div className="kicker mono">{kicker}</div>
        <h1 className="serif">{heading}</h1>
        {lead && <p className="login-lead">{lead}</p>}
        {children}
      </div>
    </main>
  );
}
