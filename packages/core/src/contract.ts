/** Coding agents Armada can launch in a sandbox. Pi and OpenCode come in v1. */
export const HARNESSES = ["claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

/** `private` is enforced by Armada: boat.dev shows its private resources to every member of the org. */
export type Visibility = "org" | "private";
