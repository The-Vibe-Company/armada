import { useSyncExternalStore } from "react";

/**
 * The page the address names. Hash routes, because the daemon serves one
 * index.html at its root: `#/plugins` is the Plugins screen, anything else the
 * home. Off a browser (a test's static render) it is the home.
 */
export type Route = "home" | "plugins";
export const routeOf = (hash: string): Route => (hash === "#/plugins" ? "plugins" : "home");

function subscribe(change: () => void) {
  window.addEventListener("hashchange", change);
  return () => window.removeEventListener("hashchange", change);
}

export function useRoute(): Route {
  return useSyncExternalStore(
    subscribe,
    () => routeOf(window.location.hash),
    () => "home",
  );
}
