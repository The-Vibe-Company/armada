import { createHash } from "node:crypto";
import {
  type OrchestratorOperation,
  type ProviderRegistry,
  reserveOrchestratorOperation,
  type Sql,
} from "@armada/core/server";
import type { BoatProvider } from "@armada/provider-boat";
import { OrchestratorRuntimeError } from "./orchestrator-runtime-store.ts";
import { mirrorStoppedHistory } from "./orchestrator-stop-history.ts";

type Input = { ownerId: string; orgId: string; id: string; expectedRevision: number; key: string };
type Recovery = {
  kind: "boat_retirement";
  source: string;
  sandboxId: string;
  providerSandboxId: string;
  generation: string;
  history?: "withheld";
};
type Row = {
  id: string;
  revision: number;
  state: OrchestratorOperation["state"];
  runtime_result: Recovery;
  error_code: string | null;
};
const wire = (row: Row, id: string): OrchestratorOperation => ({
  version: 1,
  id: row.id,
  orchestratorId: id,
  kind: "stop",
  revision: Number(row.revision),
  state: row.state,
  errorCode: row.error_code,
});

/** Explicit owner retirement, not continuity recovery. Repeated ordinary stop is
 * safe only here: the durable stop-request fence permanently forbids activation. */
export function createBoatOrchestratorRecovery(sql: Sql, providers: ProviderRegistry) {
  return async (input: Input): Promise<OrchestratorOperation> => {
    if (!sql.transaction) throw new OrchestratorRuntimeError("unavailable");
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !/^[ -~]{1,128}$/.test(input.key)
    )
      throw new OrchestratorRuntimeError("invalid_request");
    const digest = createHash("sha256")
      .update(JSON.stringify(["boat_retirement", input.ownerId, input.orgId, input.id, input.expectedRevision]))
      .digest("hex");
    async function parent(tx: Sql) {
      const row = (
        await tx.query<{ revision: number; state: string; sandbox_id: string }>(
          `select o.revision,o.state,o.sandbox_id from public.orchestrators o join public.members m on m.org_id=o.org_id and m.user_id=o.owner_id
         join public.orchestrator_runtime r on r.orchestrator_id=o.id
         where o.id=$1 and o.owner_id=$2 and o.org_id=$3 and r.configuration->>'provider'='boat' for update of o,m`,
          [input.id, input.ownerId, input.orgId],
        )
      ).rows[0];
      if (!row) throw new OrchestratorRuntimeError("not_found");
      return row;
    }
    async function bound(tx: Sql, operation: Row) {
      const current = await parent(tx);
      const b = operation.runtime_result;
      const saved = (
        await tx.query<Row>(
          `select * from public.orchestrator_operations where id=$1 and orchestrator_id=$2 and actor_id=$3 for update`,
          [operation.id, input.id, input.ownerId],
        )
      ).rows[0];
      const machine = await tx.query(
        `select id from public.sandboxes where id=$1 and provider='boat' and provider_sandbox_id=$2 and lifecycle_generation=$3 and stop_requested_at is not null for update`,
        [b.sandboxId, b.providerSandboxId, b.generation],
      );
      if (
        !saved ||
        Number(current.revision) !== Number(operation.revision) ||
        current.sandbox_id !== b.sandboxId ||
        machine.rows.length !== 1
      )
        throw new OrchestratorRuntimeError("conflict");
      return saved;
    }
    const operation = await sql.transaction(async (tx) => {
      const current = await parent(tx);
      const prior = (
        await tx.query<Row & { request_digest: string }>(
          `select * from public.orchestrator_operations where orchestrator_id=$1 and actor_id=$2 and action='stop' and idempotency_key=$3 for update`,
          [input.id, input.ownerId, input.key],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_digest !== digest || prior.runtime_result?.kind !== "boat_retirement")
          throw new OrchestratorRuntimeError("conflict");
        return prior;
      }
      if (Number(current.revision) !== input.expectedRevision || current.state !== "blocked" || !current.sandbox_id)
        throw new OrchestratorRuntimeError("conflict");
      const source = (
        await tx.query<{ id: string }>(
          `select id from public.orchestrator_operations where orchestrator_id=$1 and actor_id=$2 and revision=$3 and action='stop' and state='uncertain' for update`,
          [input.id, input.ownerId, input.expectedRevision],
        )
      ).rows[0];
      if (!source) throw new OrchestratorRuntimeError("conflict");
      const busy = await tx.query(
        `select id from public.orchestrator_operations where orchestrator_id=$1 and id<>$2 and state in ('pending','uncertain')`,
        [input.id, source.id],
      );
      if (busy.rows.length) throw new OrchestratorRuntimeError("conflict");
      const machine = (
        await tx.query<{ provider_sandbox_id: string; lifecycle_generation: string }>(
          `select provider_sandbox_id,lifecycle_generation::text from public.sandboxes where id=$1 and owner_id=$2 and org_id=$3 and provider='boat' for update`,
          [current.sandbox_id, input.ownerId, input.orgId],
        )
      ).rows[0];
      if (!machine) throw new OrchestratorRuntimeError("conflict");
      const receipt = await reserveOrchestratorOperation(
        { query: tx.query.bind(tx), transaction: async (work) => work(tx) },
        {
          orchestratorId: input.id,
          actorId: input.ownerId,
          action: "stop",
          key: input.key,
          digest,
          expectedRevision: input.expectedRevision,
        },
      );
      const result: Recovery = {
        kind: "boat_retirement",
        source: source.id,
        sandboxId: current.sandbox_id,
        providerSandboxId: machine.provider_sandbox_id,
        generation: machine.lifecycle_generation,
      };
      await tx.query(`update public.orchestrator_operations set runtime_result=$2::jsonb where id=$1`, [
        receipt.id,
        JSON.stringify(result),
      ]);
      await tx.query(`update public.sandboxes set stop_requested_at=coalesce(stop_requested_at,now()) where id=$1`, [
        current.sandbox_id,
      ]);
      await tx.query(`update public.orchestrators set state='stopping',authority_epoch=authority_epoch+1 where id=$1`, [
        input.id,
      ]);
      await tx.query(
        `update public.orchestrator_delegations set revoked_at=coalesce(revoked_at,now()) where orchestrator_id=$1`,
        [input.id],
      );
      return {
        id: receipt.id,
        revision: receipt.revision,
        state: "pending" as const,
        error_code: null,
        runtime_result: result,
      };
    });
    if (operation.state === "succeeded") return wire(operation, input.id);
    const b = operation.runtime_result;
    let stopped = false;
    try {
      await sql.transaction((tx) => bound(tx, operation));
      const source = (
        await sql.query<{
          source_golden_visibility: "org" | "private";
          orchestrator_native_generation: string | null;
          conversation_id: string | null;
          credential_kind: string | null;
        }>(
          `select s.source_golden_visibility,s.orchestrator_native_generation,r.conversation_id,c.kind as credential_kind from public.sandboxes s join public.orchestrators o on o.sandbox_id=s.id join public.orchestrator_runtime r on r.orchestrator_id=o.id left join public.credentials c on c.id=s.credential_id where s.id=$1 and s.provider_sandbox_id=$2 and s.lifecycle_generation=$3`,
          [b.sandboxId, b.providerSandboxId, b.generation],
        )
      ).rows[0];
      if (!source) throw new OrchestratorRuntimeError("conflict");
      const withholdHistory = () =>
        sql.transaction!(async (tx) => {
          await bound(tx, operation);
          await tx.query(
            `update public.orchestrator_operations set runtime_result=jsonb_set(runtime_result,'{history}','"withheld"') where id=$1`,
            [operation.id],
          );
          b.history = "withheld";
        });
      const provider = await providers.resolve(
        {
          provider: "boat",
          orgId: input.orgId,
          visibility: "private",
          sourceGoldenVisibility: source.source_golden_visibility,
          modal: null,
        },
        {
          userId: input.ownerId,
          orchestratorCleanup: {
            orchestratorId: input.id,
            sandboxId: b.sandboxId,
            providerSandboxId: b.providerSandboxId,
            generation: b.generation,
            operationId: operation.id,
          },
        },
      );
      if (provider.id !== "boat" || typeof (provider as BoatProvider).stopBestEffort !== "function")
        throw new OrchestratorRuntimeError("unavailable");
      if ((await provider.get(b.providerSandboxId)).state !== "stopped") {
        try {
          // Preserve the ordinary native-auth capture path when guest I/O works.
          await (provider as BoatProvider).stopBestEffort(b.providerSandboxId);
        } catch {
          const retire = (provider as BoatProvider).retireBestEffort;
          if (!retire) throw new OrchestratorRuntimeError("unavailable");
          // Native capture can fail before any cloud request. Retirement must
          // still remove compute, but unknown rotated secrets make its unread
          // native tail unsafe. Persist that denial BEFORE bypassing guest I/O;
          // it survives a lost cloud acknowledgement and can never be upgraded.
          await withholdHistory();
          await retire.call(provider, b.providerSandboxId);
        }
      }
      const archived = (await provider.get(b.providerSandboxId)).state === "stopped";
      const history = await sql.transaction(async (tx) => (await bound(tx, operation)).runtime_result.history);
      if (archived && history !== "withheld") {
        try {
          await mirrorStoppedHistory(
            sql,
            provider,
            {
              orchestratorId: input.id,
              sandboxId: b.sandboxId,
              providerSandboxId: b.providerSandboxId,
              generation: b.generation,
              physicalGeneration: source.orchestrator_native_generation,
            },
            operation.id,
            source.conversation_id,
          );
        } catch (error) {
          // An already archived native-auth machine cannot be safely sampled by
          // SSH. Terminal retirement may withhold its tail, never release it.
          if (source.credential_kind !== "codex_auth") throw error;
          await withholdHistory();
        }
      }
      stopped = archived;
    } catch {
      /* Preserve the retirement fence and let the same key retry archival. */
    }
    return sql.transaction(async (tx) => {
      const current = await bound(tx, operation);
      if (current.state === "succeeded") return wire(current, input.id);
      const state = stopped ? "succeeded" : "uncertain";
      const error = stopped ? null : "runtime_uncertain";
      await tx.query(`update public.orchestrator_operations set state=$2,error_code=$3 where id=$1`, [
        operation.id,
        state,
        error,
      ]);
      await tx.query(`update public.orchestrators set state=$2 where id=$1`, [
        input.id,
        stopped ? "stopped" : "blocked",
      ]);
      if (stopped) {
        await tx.query(
          `update public.sandboxes set status='stopped',stopped_at=coalesce(stopped_at,now()),last_observed_at=now() where id=$1`,
          [b.sandboxId],
        );
        await tx.query(
          `update public.orchestrator_operations set state='failed',error_code='stop_recovered_terminated' where id=$1`,
          [b.source],
        );
        await tx.query(
          `update public.orchestrator_runtime set continuity='unverified',blocked_reason=null,updated_at=now() where orchestrator_id=$1`,
          [input.id],
        );
      }
      const result = wire({ ...current, state, error_code: error }, input.id);
      await tx.query(
        `insert into public.orchestrator_runtime_events(orchestrator_id,revision,event) values($1,$2,$3::jsonb),($1,$2,$4::jsonb)`,
        [
          input.id,
          operation.revision,
          JSON.stringify({ kind: "operation", operation: result }),
          JSON.stringify({ kind: "state", state: stopped ? "stopped" : "blocked", continuity: "unverified" }),
        ],
      );
      return result;
    });
  };
}
