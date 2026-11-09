import type { OrchestratorOperation, OrchestratorScope } from "@armada/core";
import type { Sql } from "@armada/core/server";

/** Consumer projection of committed #661 PR673/026babb, not a new token/receipt protocol.
 * Structural injection keeps foundation-unavailable deployments off without an eager
 * import of unmerged code. Integration conformance assigns the exact committed producer here.
 * No fallback issuer, store, or implementation is provided. */
export interface OrchestratorRuntimeTransport {
  deliver(token: string, binding: { epoch: string; physicalGeneration: string }): Promise<{ acknowledged: boolean }>;
  scrub(tokenHash?: string): Promise<void>;
}
export interface OrchestratorRuntimeFoundation {
  reserveOperation(
    sql: Sql,
    input: {
      orchestratorId: string;
      actorId: string;
      action: OrchestratorOperation["kind"];
      key: string;
      digest: string;
      expectedRevision: number;
    },
  ): Promise<{ id: string; revision: number; state: string }>;
  authority: {
    installEpoch(
      id: string,
      transport: OrchestratorRuntimeTransport,
      consent: {
        scopes: OrchestratorScope[];
        goldenIds: string[];
        credentialIds: string[];
      },
    ): Promise<void>;
    revoke(id: string): Promise<void>;
    scrubBeforeCheckpoint(id: string, transport: OrchestratorRuntimeTransport): Promise<void>;
  };
}
