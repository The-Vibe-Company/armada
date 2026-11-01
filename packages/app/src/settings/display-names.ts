// An agent's display name (THE-2075, after T3 Code's per-instance display
// name): set in Settings › Providers, kept in this browser's localStorage, and
// shown wherever the app names the agent (the room's rows, `HarnessName`).
// Local only: nothing is sent to the daemon.
import { useSyncExternalStore } from "react";

const PREFIX = "armada.displayName.";
const watchers = new Set<() => void>();

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A browser that refuses storage keeps the agents' own names.
    return null;
  }
};

/** The owner's name for an agent (by the catalog's `mark`), or null. */
export function displayName(mark: string): string | null {
  const value = storage()
    ?.getItem(PREFIX + mark)
    ?.trim();
  return value ? value : null;
}

/** Saves an agent's name; an empty one returns to the agent's own. */
export function setDisplayName(mark: string, name: string) {
  const store = storage();
  if (!store) return;
  const value = name.trim().slice(0, 80);
  if (value) store.setItem(PREFIX + mark, value);
  else store.removeItem(PREFIX + mark);
  for (const watch of watchers) watch();
}

function subscribe(watch: () => void) {
  watchers.add(watch);
  // Another window of the app changed it.
  const storageEvent = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(PREFIX)) watch();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", storageEvent);
  return () => {
    watchers.delete(watch);
    if (typeof window !== "undefined") window.removeEventListener("storage", storageEvent);
  };
}

/** The agent's display name, re-rendered when it changes; `fallback` when none is set. */
export function useDisplayName(mark: string, fallback: string): string {
  return useSyncExternalStore(
    subscribe,
    () => displayName(mark) ?? fallback,
    () => fallback,
  );
}
