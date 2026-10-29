import type { EventInput, FleetEvent, GithubPullRequest } from "@armada/daemon/events";

/** In-process provider boundary. Loaded once at boot; no lifecycle/hot-reload machinery. */
export interface Forge {
  read(previousOpen: readonly number[], signal: AbortSignal): Promise<GithubPullRequest[]>;
}

/** Injected event sink; providers never import a daemon store/server implementation. */
export interface ForgeEvents {
  append(event: EventInput): FleetEvent;
  readSince(sequence: number, project?: string): FleetEvent[];
}
export type Schedule = (callback: () => void, milliseconds: number) => () => void;
export const schedule: Schedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
};
export type ForgeRefresh = { ok: true; changed: number } | { ok: false; error: string };
