import { createHash } from "node:crypto";
import type { Visibility } from "./contract.ts";
import { GoldenError } from "./golden-config.ts";

/** Boat saved-snapshot names: 1–63 of `[a-z0-9-]`, starting with a letter or digit. Account-wide. */
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RESERVED_SNAPSHOTS = new Set(["latest", "tree", "pull", "rm", "save", "current", "self", "new"]);

/**
 * Boat snapshot names are one namespace per account, so two orgs (or two owners on one org key)
 * cannot share a human name there. The name is a hash of org, owner, visibility and the human name:
 * two UUIDs do not fit in 63 characters of `[a-z0-9-]`.
 *
 * Node-only (`node:crypto`): kept out of `golden-config.ts` and the root `@armada/core` entrypoint
 * so a browser bundle that only needs that file's client-safe exports never has to resolve this.
 */
export function boatSnapshotName(input: {
  orgId: string;
  ownerId: string;
  visibility: Visibility;
  name: string;
}): string {
  const material = `${input.orgId.toLowerCase()}\n${input.ownerId.toLowerCase()}\n${input.visibility}\n${input.name}`;
  const digest = createHash("sha256").update(material).digest("hex");
  const snapshot = `a${digest.slice(0, 62)}`;
  if (!SNAPSHOT_NAME.test(snapshot) || RESERVED_SNAPSHOTS.has(snapshot)) {
    throw new GoldenError("invalid_config", "The boat snapshot name could not be formed.");
  }
  return snapshot;
}
