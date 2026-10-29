// Where the app is: the address's hash, because the daemon serves one
// index.html at its root. `#/projects/<id>` is a project's room (THE-1996),
// `#/projects/<id>/rules` its rules and fleet (THE-1997), `#/plugins` the
// Plugins screen, `#/settings` the coordinator's model; anything else, and off
// a browser (a test's static render), the hangar (the home, THE-2025). A
// session's page, `#/sessions/<ticket>`, has its own route (src/session/route.ts).
import { useSyncExternalStore } from "react";

export type Route =
  | { kind: "home" }
  | { kind: "project"; id: string }
  | { kind: "rules"; id: string }
  | { kind: "plugins" }
  | { kind: "settings" };

const decode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    // A malformed address returns to the hangar.
    return null;
  }
};

/** The screen a hash names. */
export function routeOf(hash: string): Route {
  if (hash === "#/plugins") return { kind: "plugins" };
  if (hash === "#/settings") return { kind: "settings" };
  const [kind, id, more, ...rest] = hash.replace(/^#?\/?/, "").split("/");
  const value = id && !rest.length ? decode(id) : null;
  if (!value) return { kind: "home" };
  if (kind === "projects" && more === undefined) return { kind: "project", id: value };
  if (kind === "projects" && more === "rules") return { kind: "rules", id: value };
  return { kind: "home" };
}

/** Where a project's squadron and its sidebar line lead: its room. */
export const projectHref = (id: string) => `#/projects/${encodeURIComponent(id)}`;
export const roomHref = projectHref;
export const rulesHref = (project: string) => `${projectHref(project)}/rules`;

const subscribe = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};
const current = () => window.location.hash;
const server = () => "#/";

/** The current route, re-rendered when the hash changes; the hangar on the server. */
export function useRoute(): Route {
  return routeOf(useSyncExternalStore(subscribe, current, server));
}
