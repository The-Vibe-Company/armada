// The organization's pages (THE-1021, design/dashboard-v7): its name over
// one line, the tabs (members, API keys, GitHub, workers), then each tab's
// hint beside its one action and its rows: a name and its detail, a second
// fact, a state in its color, and what to do with it. An action or a row's
// "Manage" opens its forms below it (a disclosure: the pages are rendered on
// the server and work before any script).
import type { ReactNode } from "react";
import type { Strings } from "@/lib/i18n";
import { type OrganizationPage, OrganizationTabs } from "./OrganizationTabs";

export function OrgPage({
  t,
  name,
  page,
  children,
}: {
  t: Strings;
  name: string;
  page: OrganizationPage;
  children: ReactNode;
}) {
  return (
    <div className="pg is-narrow org">
      <div className="pg-head">
        <p className="pg-title">{name}</p>
        <p className="pg-sub">{t.org.lead}</p>
      </div>
      <OrganizationTabs t={t} page={page} />
      {children}
    </div>
  );
}

/** A tab's hint, and its one action on the right. */
export function OrgBar({ hint, children }: { hint: ReactNode; children?: ReactNode }) {
  return (
    <div className="org-bar">
      <div className="org-hint">{hint}</div>
      {children}
    </div>
  );
}

/** A button that opens its forms in a panel under it: "Invite", "New key", a row's "Manage". */
export function Disclose({
  label,
  primary = false,
  children,
}: {
  label: ReactNode;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <details className={primary ? "org-disclose is-primary" : "org-disclose"}>
      <summary className={primary ? "btn is-primary" : "org-link"}>{label}</summary>
      <div className="org-panel">{children}</div>
    </details>
  );
}

/** A list's title over its rows, when a tab holds more than one list. */
export function OrgHeading({ children, side }: { children: ReactNode; side?: ReactNode }) {
  return (
    <div className="org-h">
      <h2>{children}</h2>
      {side}
    </div>
  );
}

export function OrgRows({ children }: { children: ReactNode }) {
  return <ul className="org-rows">{children}</ul>;
}

/** One row: `a` over `sub`, `b`, `c` in `color`, and `d` (a link, a button or a disclosure). */
export function OrgRow({
  a,
  sub,
  subMono = false,
  b,
  bMono = false,
  c,
  color,
  d,
}: {
  a: ReactNode;
  sub?: ReactNode;
  subMono?: boolean;
  b?: ReactNode;
  bMono?: boolean;
  c?: ReactNode;
  color?: string;
  d?: ReactNode;
}) {
  return (
    <li className="org-row">
      <span className="org-a">
        <span className="org-name">{a}</span>
        {sub && <span className={subMono ? "org-sub mono" : "org-sub"}>{sub}</span>}
      </span>
      <span className={bMono ? "org-b mono" : "org-b"}>{b}</span>
      <span className="org-c" style={color ? { color } : undefined}>
        {c}
      </span>
      <span className="org-d">{d}</span>
    </li>
  );
}

/** A row's or a list's "nothing yet". */
export function OrgNone({ children }: { children: ReactNode }) {
  return <li className="org-none">{children}</li>;
}
