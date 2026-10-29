// A session's page in the address's hash (THE-2028): `#/sessions/<ticket>`,
// `?tab=files` for its pull request's files. Kept apart from the app's other
// routes so one line of App.tsx opens it, whatever router the others share.
import { useSyncExternalStore } from "react";

export const TABS = ["reports", "files"] as const;
export type Tab = (typeof TABS)[number];

export interface SessionRoute {
  ticket: string;
  tab: Tab;
}

/** A session's page; the reports tab is the page's own address. */
export const sessionHref = (ticket: string, tab: Tab = "reports") =>
  `#/sessions/${encodeURIComponent(ticket)}${tab === "reports" ? "" : `?tab=${tab}`}`;

/** The session a hash names, or null for any other page. */
export function parseSessionRoute(hash: string): SessionRoute | null {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const ticket = path.replace(/\/+$/, "").match(/^sessions\/([^/]+)$/)?.[1];
  if (!ticket) return null;
  try {
    const tab = new URLSearchParams(query).get("tab");
    return { ticket: decodeURIComponent(ticket), tab: tab === "files" ? "files" : "reports" };
  } catch {
    // A malformed escape names no session.
    return null;
  }
}

const subscribe = (change: () => void) => {
  window.addEventListener("hashchange", change);
  return () => window.removeEventListener("hashchange", change);
};

/** The session the address names, followed as the hash changes; none off a browser. */
export function useSessionRoute(): SessionRoute | null {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
  return parseSessionRoute(hash);
}
