// Where the app is: the address's hash, because the daemon serves one
// index.html at its root. `#/projects/<id>` is a project's room (THE-1996),
// `#/projects/<id>/rules` its rules and fleet (THE-1997), `#/settings/<section>`
// a section of the settings (THE-2069: `#/settings` opens the coordinator's,
// the old `#/plugins` is replaced by the providers'); anything else, and off a
// browser (a test's static render), the hangar (the home, THE-2025). A
// session's page, `#/sessions/<ticket>`, has its own route (src/session/route.ts).
import { useEffect, useSyncExternalStore } from "react";

/** The settings' sections, in the nav's order; the first is `#/settings`. */
export const SETTINGS_SECTIONS = ["coordinator", "providers", "account", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route =
  | { kind: "home" }
  | { kind: "project"; id: string }
  | { kind: "rules"; id: string }
  | { kind: "settings"; section: SettingsSection; redirect?: string };

/** Where a section of the settings is. */
export const settingsHref = (section: SettingsSection) => `#/settings/${section}`;

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
  const [kind, id, more, ...rest] = hash.replace(/^#?\/?/, "").split("/");
  // The Plugins screen became the providers' section: its old address is replaced, once.
  if (kind === "plugins" && !id) return { kind: "settings", section: "providers", redirect: settingsHref("providers") };
  if (kind === "settings" && more === undefined) {
    const section = SETTINGS_SECTIONS.find((s) => s === id) ?? "coordinator";
    return { kind: "settings", section };
  }
  const value = id && !rest.length ? decode(id) : null;
  if (!value) return { kind: "home" };
  if (kind === "projects" && more === undefined) return { kind: "project", id: value };
  if (kind === "projects" && more === "rules") return { kind: "rules", id: value };
  return { kind: "home" };
}

/** Where a project's squadron and its sidebar line lead: its room. */
export const projectHref = (id: string) => `#/projects/${encodeURIComponent(id)}`;
export const rulesHref = (project: string) => `${projectHref(project)}/rules`;

const subscribe = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};
const current = () => window.location.hash;
const server = () => "#/";

/** The address a route is replaced by, if any. */
const redirectOf = (route: Route) => (route.kind === "settings" ? route.redirect : undefined);

/** The current route, re-rendered when the hash changes; the hangar on the server. */
export function useRoute(): Route {
  const route = routeOf(useSyncExternalStore(subscribe, current, server));
  const redirect = redirectOf(route);
  useEffect(() => {
    // Replaced, not pushed: Back never returns to the old address. Every caller
    // of useRoute sees the redirect: the first replaces it, the others find it done.
    if (redirect && redirectOf(routeOf(window.location.hash))) window.location.replace(redirect);
  }, [redirect]);
  return route;
}
