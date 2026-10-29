// Where the app is: the address's hash, because the daemon serves one
// index.html at its root. `#/projects/<id>` is a project's room (THE-1996),
// `#/projects/<id>/rules` its rules and fleet (THE-1997), `#/sessions/<ticket>`
// a session's page (a placeholder until the local runtime, docs/v2-desktop.md
// step 3), `#/plugins` the Plugins screen; anything else, and off a browser
// (a test's static render), the fleet.
import { useSyncExternalStore } from "react";

export type Route =
  | { kind: "home" }
  | { kind: "project"; id: string }
  | { kind: "rules"; id: string }
  | { kind: "session"; ticket: string }
  | { kind: "plugins" };

const decode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    // A malformed address returns to the fleet.
    return null;
  }
};

/** The screen a hash names. */
export function routeOf(hash: string): Route {
  if (hash === "#/plugins") return { kind: "plugins" };
  const [kind, id, more, ...rest] = hash.replace(/^#?\/?/, "").split("/");
  const value = id && !rest.length ? decode(id) : null;
  if (!value) return { kind: "home" };
  if (kind === "projects" && more === undefined) return { kind: "project", id: value };
  if (kind === "projects" && more === "rules") return { kind: "rules", id: value };
  if (kind === "sessions" && more === undefined) return { kind: "session", ticket: value };
  return { kind: "home" };
}

export const roomHref = (project: string) => `#/projects/${encodeURIComponent(project)}`;
export const rulesHref = (project: string) => `${roomHref(project)}/rules`;
export const sessionHref = (ticket: string) => `#/sessions/${encodeURIComponent(ticket)}`;

const subscribe = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};
const current = () => window.location.hash;
const server = () => "#/";

/** The current route, re-rendered when the hash changes; the fleet on the server. */
export function useRoute(): Route {
  return routeOf(useSyncExternalStore(subscribe, current, server));
}
