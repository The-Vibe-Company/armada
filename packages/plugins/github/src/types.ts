import type { EventInput, EventPayloads, FleetEvent, GithubPullRequest } from "@armada/daemon/events";
import type { GithubCheckpoint } from "./checkpoint.ts";
import type { ReviewFact } from "./reviews.ts";

/** In-process provider boundary. Loaded once at boot; no lifecycle/hot-reload machinery. */
export interface Forge {
  readonly defaultBranch?: EventPayloads["default-branch.seen"];
  read(previousOpen: readonly number[], signal: AbortSignal, context?: ForgeReadContext): Promise<GithubPullRequest[]>;
}

/** Injected event sink; providers never import a daemon store/server implementation. */
export interface ForgeEvents {
  append(event: EventInput): FleetEvent | Promise<FleetEvent>;
  readSince(sequence: number, project?: string): FleetEvent[] | Promise<FleetEvent[]>;
}
export type Schedule = (callback: () => void, milliseconds: number) => () => void;
export const schedule: Schedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
};
export type ForgeRefresh = { ok: true; changed: number } | { ok: false; error: string };

export interface ForgeReadContext {
  onDetails?: () => void;
  checkpoint: GithubCheckpoint;
  at: string;
  events: ReviewFact[];
}
