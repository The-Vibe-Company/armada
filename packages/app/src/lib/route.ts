import { useSyncExternalStore } from "react";

/**
 * The page the address names. Hash routes, because the daemon serves one
 * index.html at its root: `#/projects/<id>` a project, `#/plugins` the Plugins
 * screen, `#/settings` the coordinator's model, anything else the hangar (the
 * home, THE-2025). Off a browser (a test's static render) it is the hangar.
 */
export type Route = { kind: "home" } | { kind: "project"; id: string } | { kind: "plugins" } | { kind: "settings" };

/** Where a project's squadron and its sidebar line lead. */
export const projectHref = (id: string) => `#/projects/${encodeURIComponent(id)}`;

const subscribe = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};
const current = () => window.location.hash;
const server = () => "#/";

export function routeOf(hash: string): Route {
  if (hash === "#/plugins") return { kind: "plugins" };
  if (hash === "#/settings") return { kind: "settings" };
  const match = /^#\/projects\/([^/?#]+)$/.exec(hash);
  if (match?.[1]) {
    try {
      return { kind: "project", id: decodeURIComponent(match[1]) };
    } catch {
      /* A malformed address returns to the fleet. */
    }
  }
  return { kind: "home" };
}

export function useRoute(): Route {
  return routeOf(useSyncExternalStore(subscribe, current, server));
}
