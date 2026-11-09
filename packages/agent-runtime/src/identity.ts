import { createHash } from "node:crypto";
import type { CheckpointIdentity } from "./protocol.ts";
/** Canonical scope excludes bearer material even when a full Grant is supplied. */
export function checkpointIdentity(value: CheckpointIdentity): CheckpointIdentity {
  if (
    !value ||
    typeof value.sandboxId !== "string" ||
    !value.sandboxId ||
    !(
      (typeof value.generation === "string" && value.generation.length > 0) ||
      (typeof value.generation === "number" && Number.isSafeInteger(value.generation) && value.generation > 0)
    )
  )
    throw Error("invalid_checkpoint_identity");
  return Object.freeze({ sandboxId: value.sandboxId, generation: String(value.generation) });
}
export function checkpointIdentityKey(value: CheckpointIdentity): string {
  const id = checkpointIdentity(value);
  return createHash("sha256")
    .update(JSON.stringify([id.sandboxId, id.generation]))
    .digest("hex");
}
export function sameCheckpointIdentity(a: CheckpointIdentity | null, b: CheckpointIdentity): boolean {
  return a !== null && checkpointIdentityKey(a) === checkpointIdentityKey(b);
}
