// Where the app is (THE-1996): the address's hash, `#/projects/<id>` for a
// project's room, `#/sessions/<ticket>` for a session's page (a placeholder
// until the local runtime, docs/v2-desktop.md step 3), anything else home.
import { useSyncExternalStore } from "react";

export type Route = { screen: "home" } | { screen: "room"; project: string } | { screen: "session"; ticket: string };

const decode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
};

/** The screen a hash names. */
export function routeOf(hash: string): Route {
  const [kind, id, ...rest] = hash.replace(/^#?\/?/, "").split("/");
  const value = id && !rest.length ? decode(id) : null;
  if (kind === "projects" && value) return { screen: "room", project: value };
  if (kind === "sessions" && value) return { screen: "session", ticket: value };
  return { screen: "home" };
}

export const roomHref = (project: string) => `#/projects/${encodeURIComponent(project)}`;
export const sessionHref = (ticket: string) => `#/sessions/${encodeURIComponent(ticket)}`;

const subscribe = (change: () => void) => {
  window.addEventListener("hashchange", change);
  return () => window.removeEventListener("hashchange", change);
};
const hash = () => window.location.hash;
const none = () => "";

/** The current hash, re-rendered when it changes; empty on the server. */
export function useHash(): string {
  return useSyncExternalStore(subscribe, hash, none);
}
