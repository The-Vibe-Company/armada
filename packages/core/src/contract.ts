/** Coding agents Armada can launch in a sandbox. Pi and OpenCode come in v1. */
export const HARNESSES = ["claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

/** `private` is enforced by Armada: boat.dev shows its private resources to every member of the org. */
export type Visibility = "org" | "private";

/** A placement agents run on. v0 has one, boat.dev; the operations arrive with its adapter. */
export interface Provider {
  readonly id: string;
  readonly harnesses: readonly Harness[];
}
