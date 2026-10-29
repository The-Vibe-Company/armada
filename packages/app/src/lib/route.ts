import { useSyncExternalStore } from "react";

/**
 * The page the address names. Hash routes, because the daemon serves one
 * index.html at its root: `#/projects/<id>` a project, `#/plugins` the Plugins
 * screen, anything else the fleet. Off a browser (a test's static render) it is the fleet.
 */
export type Route = { kind: "home" } | { kind: "project"; id: string } | { kind: "plugins" };

const subscribe = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};
const current = () => window.location.hash;
const server = () => "#/";

export function routeOf(hash: string): Route {
  if (hash === "#/plugins") return { kind: "plugins" };
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
