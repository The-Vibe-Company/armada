// The app's routes, in the address's hash (THE-2025): the daemon serves one
// page, and the desktop shell opens it from a file, so the path never moves.
// Pure rules and one hook; a screen's route is one line here and one in App.tsx.
import { useSyncExternalStore } from "react";

export type Route =
  /** `#/`: the hangar, every project a squadron in one sky (the home). */
  | { screen: "hangar" }
  /** `#/projects/<id>`: a project's room. */
  | { screen: "project"; id: string }
  /** `#/settings`: the coordinator's model. */
  | { screen: "settings" };

export const href = {
  hangar: "#/",
  project: (id: string) => `#/projects/${encodeURIComponent(id)}`,
  settings: "#/settings",
} as const;

/** The route a hash names; any other hash is the hangar. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").replace(/\/+$/, "");
  if (path === "settings") return { screen: "settings" };
  const project = path.match(/^projects\/([^/]+)$/)?.[1];
  if (project) {
    try {
      return { screen: "project", id: decodeURIComponent(project) };
    } catch {
      // A malformed escape names no project.
    }
  }
  return { screen: "hangar" };
}

const subscribe = (change: () => void) => {
  window.addEventListener("hashchange", change);
  return () => window.removeEventListener("hashchange", change);
};

/** The current route, followed as the hash changes; the hangar on the server. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
  return parseRoute(hash);
}
