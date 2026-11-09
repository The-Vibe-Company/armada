import type { Harness } from "@armada/core";
import { refusal } from "./errors.ts";
import type { Machine } from "./ports.ts";

/** Safe native evidence only. No native auth, authority bearer or checkpoint bytes. */
export interface ModalOrchestratorCheckpoint {
  version: 1;
  operationId: string;
  sandboxId: string;
  physicalGeneration: string;
  conversationId: string | null;
  nativeSessionId: string | null;
  harness: Harness;
  model: string;
  reasoningEffort?: string;
  cwd?: string;
  eventWatermark: number;
  acknowledgedSequence: number;
  checkpointId: string | null;
  state: "pending" | "stopped";
}
export interface ModalOrchestratorCheckpointRecord {
  receipt: ModalOrchestratorCheckpoint;
  restore?: { operationId: string; generation?: string; verified: boolean };
}
export function checkpointReceipt(row: Machine, operationId: string): ModalOrchestratorCheckpoint | null {
  const saved = row.orchestratorCheckpoint?.receipt;
  if (!saved || saved.operationId !== operationId || saved.sandboxId !== row.info.id) return null;
  const complete =
    row.phase === "stopped" &&
    String(row.generation) === saved.physicalGeneration &&
    row.quiesced === true &&
    !!row.recoveryImageId &&
    row.checkpointWatermark === saved.eventWatermark &&
    saved.acknowledgedSequence === saved.eventWatermark;
  // A later restore is not evidence for a pending source stop. A previously
  // complete immutable receipt remains readable; restore separately checks source.
  return {
    ...saved,
    checkpointId: complete ? row.recoveryImageId! : saved.checkpointId,
    state: complete ? "stopped" : saved.state,
  };
}
export function assertSameCheckpoint(a: ModalOrchestratorCheckpoint, b: ModalOrchestratorCheckpoint) {
  const fields: (keyof ModalOrchestratorCheckpoint)[] = [
    "version",
    "operationId",
    "sandboxId",
    "physicalGeneration",
    "conversationId",
    "nativeSessionId",
    "harness",
    "model",
    "reasoningEffort",
    "cwd",
    "eventWatermark",
    "acknowledgedSequence",
    "checkpointId",
    "state",
  ];
  if (
    Object.keys(a).some((key) => !fields.includes(key as keyof ModalOrchestratorCheckpoint)) ||
    fields.some((key) => a[key] !== b[key])
  )
    throw refusal("conflict", "Native checkpoint identity changed.");
}
