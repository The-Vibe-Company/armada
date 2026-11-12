export { HARNESSES, type Harness } from "./harnesses.ts";

/** `private` is enforced by Armada: boat.dev shows its private resources to every member of the org. */
export type Visibility = "org" | "private";
