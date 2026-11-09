import type { Provider, SandboxProviderId } from "@armada/core";
import type { Sql } from "@armada/core/server";
import type { OrchestratorRuntimeFoundation } from "./orchestrator-runtime-foundation.ts";
import { OrchestratorRuntimeError } from "./orchestrator-runtime-store.ts";
import { createOrchestratorTransport } from "./orchestrator-transport.ts";

/** Exact consumer projection of #663 source-contracts-v2/d20be62a.
 * generation is the SQL CAS counter, NOT provider-native physicalGeneration. */
export interface ManagedMachine {
  orchestratorId: string;
  sandboxId: string;
  providerSandboxId: string;
  generation: string;
  physicalGeneration?: string | null;
}
export interface ManagedObservation extends ManagedMachine {
  physicalGeneration: string | null;
  state: "active" | "quiescent" | "unknown";
  evidence: string;
}
export interface ManagedStopReceipt extends ManagedMachine {
  physicalGeneration: string | null;
  operationId: string;
  state: "stopped" | "uncertain" | "interrupted";
  continuity: "native" | "unverified" | "lost";
}
export type ManagedStopReason = "idle" | "hard_ttl" | "epoch_expiry" | "owner_removed";
export interface ManagedSelection {
  orgId: string;
  ownerId: string;
  goldenId: string;
  provider: SandboxProviderId;
  operationId?: string;
}
export interface ManagedNativeBackend {
  provider: Provider;
  mcpUrl: string;
  observe(machine: ManagedMachine, signal?: AbortSignal): Promise<ManagedObservation>;
  checkpointAndStop(machine: ManagedMachine, operationId: string, signal?: AbortSignal): Promise<ManagedStopReceipt>;
  /** Durable history recovery only, after a correlated stopped receipt. Never compute I/O. */
  recoverStopHistory?(machine: ManagedMachine, operationId: string): Promise<void>;
  /** A read-only lookup of this EXACT native operation. Never retries stop/restores/allocates. */
  readStopReceipt(
    machine: ManagedMachine,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ManagedStopReceipt | null>;
}

function correlated(machine: ManagedMachine, other: ManagedMachine): boolean {
  return (
    machine.orchestratorId === other.orchestratorId &&
    machine.sandboxId === other.sandboxId &&
    machine.providerSandboxId === other.providerSandboxId &&
    machine.generation === other.generation &&
    (machine.physicalGeneration === undefined || machine.physicalGeneration === other.physicalGeneration)
  );
}
function receipt(machine: ManagedMachine, operationId: string, value: ManagedStopReceipt): ManagedStopReceipt {
  if (
    !value ||
    !correlated(machine, value) ||
    value.operationId !== operationId ||
    !["stopped", "uncertain", "interrupted"].includes(value.state) ||
    !["native", "unverified", "lost"].includes(value.continuity) ||
    (value.state !== "stopped" && value.continuity === "native")
  )
    throw new OrchestratorRuntimeError("conflict");
  // Project only the safe receipt, never persist arbitrary provider response properties.
  return {
    ...machine,
    physicalGeneration: value.physicalGeneration ?? null,
    operationId,
    state: value.state,
    continuity: value.continuity,
  };
}
function observation(machine: ManagedMachine, value: ManagedObservation): ManagedObservation {
  if (
    !value ||
    !correlated(machine, value) ||
    !["active", "quiescent", "unknown"].includes(value.state) ||
    typeof value.evidence !== "string" ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(value.evidence) ||
    value.evidence.includes("armada_epoch_")
  )
    throw new OrchestratorRuntimeError("conflict");
  return {
    ...machine,
    physicalGeneration: value.physicalGeneration ?? null,
    state: value.state,
    evidence: value.evidence,
  };
}
const uncertain = (machine: ManagedMachine, operationId: string): ManagedStopReceipt => ({
  ...machine,
  physicalGeneration: machine.physicalGeneration ?? null,
  operationId,
  state: "uncertain",
  continuity: "unverified",
});

/** Trusted lifecycle composition, deliberately not a Caller/HTTP tool. Compute cleanup
 * after owner removal uses persisted provider binding, never current-user credentials.
 * The real native backend is mandatory; no flag/capability can fabricate checkpoint proof. */
export function createManagedOrchestratorRuntime(options: {
  sql: Sql;
  authority: OrchestratorRuntimeFoundation["authority"];
  resolveManaged(machine: ManagedMachine, selection: ManagedSelection): Promise<ManagedNativeBackend>;
}) {
  const { sql } = options;
  async function resolve(machine: ManagedMachine, selection: ManagedSelection): Promise<ManagedNativeBackend> {
    let backend: ManagedNativeBackend;
    try {
      backend = await options.resolveManaged(machine, selection);
    } catch {
      throw new OrchestratorRuntimeError("unavailable");
    }
    if (backend.provider.id !== selection.provider) throw new OrchestratorRuntimeError("conflict");
    return backend;
  }
  async function readNative<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new OrchestratorRuntimeError("unavailable");
    }
  }
  type Bound = {
    selection: ManagedSelection;
    revision: string;
    state: string;
    result: unknown;
    operationState: string | null;
  };
  async function bound(machine: ManagedMachine, operationId?: string, tx: Sql = sql, lock = false): Promise<Bound> {
    const rows = await tx.query<{
      org_id: string;
      owner_id: string;
      golden_id: string;
      provider: SandboxProviderId;
      revision: string | number;
      state: string;
    }>(
      `select o.org_id,o.owner_id,o.revision,o.state,s.golden_id,s.provider from public.orchestrators o
      join public.sandboxes s on s.id=o.sandbox_id where o.id=$1 and s.id=$2 and s.provider_sandbox_id=$3
      and s.lifecycle_generation=$4 and ($5::text is null or s.orchestrator_native_generation=$5) ${lock ? "for update of o,s" : ""}`,
      [
        machine.orchestratorId,
        machine.sandboxId,
        machine.providerSandboxId,
        machine.generation,
        machine.physicalGeneration ?? null,
      ],
    );
    const row = rows.rows[0];
    if (!row) throw new OrchestratorRuntimeError("conflict");
    let result: unknown = null;
    let operationState: string | null = null;
    if (operationId) {
      const operation = (
        await tx.query<{ runtime_result: unknown; state: string }>(
          `select runtime_result,state from public.orchestrator_operations
        where id=$1 and orchestrator_id=$2 and action='stop' and revision=$3 ${lock ? "for update" : ""}`,
          [operationId, machine.orchestratorId, row.revision],
        )
      ).rows[0];
      if (!operation) throw new OrchestratorRuntimeError("conflict");
      result = operation.runtime_result;
      operationState = operation.state;
    }
    return {
      selection: { orgId: row.org_id, ownerId: row.owner_id, goldenId: row.golden_id, provider: row.provider },
      revision: String(row.revision),
      state: row.state,
      result,
      operationState,
    };
  }
  function recorded(machine: ManagedMachine, operationId: string, value: unknown): ManagedStopReceipt | null {
    if (value === null || value === undefined) return null;
    return receipt(machine, operationId, value as ManagedStopReceipt);
  }
  async function save(
    machine: ManagedMachine,
    operationId: string,
    revision: string,
    value: ManagedStopReceipt,
  ): Promise<boolean> {
    if (!sql.transaction) throw new OrchestratorRuntimeError("unavailable");
    return sql.transaction(async (tx) => {
      const current = await bound(machine, operationId, tx, true);
      if (current.revision !== revision) return false;
      const saved = await tx.query(
        `update public.orchestrator_operations set runtime_result=$2::jsonb where id=$1 and revision=$3 returning id`,
        [operationId, JSON.stringify(receipt(machine, operationId, value)), revision],
      );
      if (saved.rows.length === 1 && value.state === "stopped")
        await tx.query(
          `update public.sandboxes set status='stopped',stopped_at=coalesce(stopped_at,now()),last_observed_at=now() where id=$1 and lifecycle_generation=$2`,
          [machine.sandboxId, machine.generation],
        );
      return saved.rows.length === 1;
    });
  }
  async function dispatchStop(
    machine: ManagedMachine,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ManagedStopReceipt> {
    signal?.throwIfAborted();
    if (!sql.transaction) throw new OrchestratorRuntimeError("unavailable");
    const claim = await sql.transaction(async (tx) => {
      const current = await bound(machine, operationId, tx, true);
      if (!["stopping", "blocked"].includes(current.state)) throw new OrchestratorRuntimeError("conflict");
      const prior = recorded(machine, operationId, current.result);
      if (prior || current.operationState !== "pending") return { ...current, fresh: false };
      // The actual208 receipt is the dispatch fence, not a second operation store.
      await tx.query(`update public.orchestrator_operations set runtime_result=$2::jsonb where id=$1`, [
        operationId,
        JSON.stringify(uncertain(machine, operationId)),
      ]);
      return { ...current, fresh: true };
    });
    if (!claim.fresh) return runtime.reconcileStop(machine, operationId, signal);
    let value = uncertain(machine, operationId);
    try {
      await options.authority.revoke(machine.orchestratorId);
      const backend = await resolve(machine, { ...claim.selection, operationId });
      const native = await backend.provider.get(machine.providerSandboxId);
      if (machine.physicalGeneration && native.physicalGeneration !== machine.physicalGeneration)
        throw new OrchestratorRuntimeError("conflict");
      if (native.physicalGeneration) {
        await sql.transaction!(async (tx) => {
          const current = await bound(machine, operationId, tx, true);
          if (current.revision !== claim.revision) throw new OrchestratorRuntimeError("conflict");
          const boundNative = await tx.query(
            `update public.sandboxes set orchestrator_native_generation=$2 where id=$1 and (orchestrator_native_generation is null or orchestrator_native_generation=$2) returning id`,
            [machine.sandboxId, native.physicalGeneration],
          );
          if (boundNative.rows.length !== 1) throw new OrchestratorRuntimeError("conflict");
          machine = { ...machine, physicalGeneration: native.physicalGeneration! };
          await tx.query(`update public.orchestrator_operations set runtime_result=$2::jsonb where id=$1`, [
            operationId,
            JSON.stringify(uncertain(machine, operationId)),
          ]);
        });
      }
      if (
        !native.physicalGeneration ||
        !["ready", "running"].includes(native.state) ||
        !backend.provider.quiesceOrchestrator
      )
        throw new OrchestratorRuntimeError("unavailable");
      const drained = await backend.provider.quiesceOrchestrator({
        sandboxId: machine.providerSandboxId,
        physicalGeneration: native.physicalGeneration,
      });
      if (drained.acknowledged !== true) throw new OrchestratorRuntimeError("unavailable");
      const observed = observation(machine, await readNative(() => backend.observe(machine, signal)));
      if (observed.state !== "quiescent") throw new OrchestratorRuntimeError("conflict");
      const afterDrain = await bound(machine, operationId);
      if (afterDrain.revision !== claim.revision || !["stopping", "blocked"].includes(afterDrain.state))
        throw new OrchestratorRuntimeError("conflict");
      const transport = createOrchestratorTransport({
        provider: backend.provider,
        providerSandboxId: machine.providerSandboxId,
        physicalGeneration: native.physicalGeneration,
        lifecycleGeneration: machine.generation,
        mcpUrl: backend.mcpUrl,
      });
      await options.authority.scrubBeforeCheckpoint(machine.orchestratorId, transport);
      signal?.throwIfAborted();
      value = receipt(machine, operationId, await backend.checkpointAndStop(machine, operationId, signal));
    } catch {
      /* Ambiguous native effects are reconciled by operation, never replayed. */
    }
    if (!(await save(machine, operationId, claim.revision, value))) throw new OrchestratorRuntimeError("conflict");
    return value;
  }
  const runtime = {
    async observe(machine: ManagedMachine, signal?: AbortSignal): Promise<ManagedObservation> {
      signal?.throwIfAborted();
      const current = await bound(machine);
      const backend = await resolve(machine, current.selection);
      const observed = observation(machine, await readNative(() => backend.observe(machine, signal)));
      const after = await bound(machine); // Membership is intentionally not required, but incarnation is.
      if (after.revision !== current.revision || after.state !== current.state)
        throw new OrchestratorRuntimeError("conflict");
      return {
        ...machine,
        physicalGeneration: observed.physicalGeneration ?? null,
        state: observed.state,
        evidence: observed.evidence,
      };
    },
    stop(
      machine: ManagedMachine,
      _reason: ManagedStopReason,
      operationId: string,
      signal?: AbortSignal,
    ): Promise<ManagedStopReceipt> {
      return dispatchStop(machine, operationId, signal);
    },
    /** Owner authorization stays in the shared public runtime, not this trusted native adapter. */
    stopOwner(machine: ManagedMachine, operationId: string, signal?: AbortSignal): Promise<ManagedStopReceipt> {
      return dispatchStop(machine, operationId, signal);
    },
    async reconcileStop(
      machine: ManagedMachine,
      operationId: string,
      signal?: AbortSignal,
    ): Promise<ManagedStopReceipt> {
      signal?.throwIfAborted();
      const current = await bound(machine, operationId);
      const old = recorded(machine, operationId, current.result);
      if (!old) return uncertain(machine, operationId); // No dispatch fence, no provider lookup or work.
      if (old.state !== "uncertain") return old;
      const backend = await resolve(machine, { ...current.selection, operationId });
      const observed = await readNative(() => backend.readStopReceipt(machine, operationId, signal));
      await bound(machine, operationId);
      if (!observed) return old;
      const reconciled = receipt(machine, operationId, observed);
      if (reconciled.state === "stopped") await backend.recoverStopHistory?.(reconciled, operationId);
      return reconciled;
    },
  };
  return runtime;
}
