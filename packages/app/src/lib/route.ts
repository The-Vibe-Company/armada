import { useSyncExternalStore } from "react";

const subscribe = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};
const current = () => window.location.hash;
const server = () => "#/";

export function useRoute(): { kind: "home" } | { kind: "project"; id: string } {
  const hash = useSyncExternalStore(subscribe, current, server);
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
