import { createHash } from "node:crypto";
import { MAX_SANDBOX_EXTENSION_TTL_SECONDS } from "@armada/core";
import { type Harness, type LaunchRequest, parseMachineSize, type Sql } from "@armada/core/server";
import { ChildLaunchNotAllocated } from "./orchestrator-child-launch.ts";
import type { ChildAuthority } from "./orchestrator-lifecycle-contract.ts";
import { orchestratorRuntimeOperations } from "./orchestrator-runtime-operation.ts";

export interface ChildLaunchSelection {
  goldenId: string;
  harness: Harness;
  credentialId: string;
  credentialVersion: number;
  model: string;
  size?: NonNullable<LaunchRequest["size"]>;
  reasoningEffort?: string;
  repo?: string;
  prompt?: string;
}
export interface ChildOperation {
  id: string;
  orchestratorId: string;
  ownerId: string;
  orgId: string;
  parentGeneration: string;
  parentEpoch: string;
  action: "launch" | "message" | "stop" | "extend";
  sandboxId: string;
}
/** Runtime caller must use this exact reserved sandbox ID and provider idempotency key.
 * Unknown allocation has no retry path: reconcile the original correlation only.
 * Model-account resolution remains #612/#661's responsibility, never guest credentials. */
export interface OrchestratorChildExecutor {
  launch(operation: ChildOperation, selection: ChildLaunchSelection): Promise<{ providerSandboxId: string }>;
  message(operation: ChildOperation, text: string): Promise<void>;
  stop(operation: ChildOperation): Promise<void>;
  extend?(operation: ChildOperation, ttlSeconds: number): Promise<void>;
  /** Exact original receipt discovery only; absence/timeout must return unknown. */
  reconcile(
    operation: ChildOperation,
    signal?: AbortSignal,
  ): Promise<{
    operationId: string;
    sandboxId: string;
    state: "succeeded" | "failed" | "unknown";
    providerSandboxId?: string;
    noAllocation?: boolean;
    /** Positive exact SDK stop/exit evidence, never absence/404 or an uncorrelated resource. */
    resourceStopped?: boolean;
  }>;
  read(sandboxId: string, ownerId: string, orgId: string): Promise<unknown>;
}

export function createOrchestratorChildren(sql: Sql, authority: ChildAuthority, executor: OrchestratorChildExecutor) {
  const operations = orchestratorRuntimeOperations();
  async function mutate(
    token: string,
    key: string,
    input:
      | { action: "launch"; selection: ChildLaunchSelection }
      | { action: "message"; sandboxId: string; text: string }
      | { action: "stop"; sandboxId: string }
      | { action: "extend"; sandboxId: string; ttlSeconds: number },
  ) {
    if (
      input.action === "extend" &&
      (!Number.isSafeInteger(input.ttlSeconds) ||
        input.ttlSeconds < 1 ||
        input.ttlSeconds > MAX_SANDBOX_EXTENSION_TTL_SECONDS)
    )
      throw new Error("Invalid extension duration.");
    if (!/^[ -~]{1,128}$/.test(key) || (input.action === "message" && !input.text.trim()))
      throw new Error("Invalid child operation.");
    if (input.action === "launch") {
      const selected = input.selection;
      const allowed = [
        "goldenId",
        "harness",
        "credentialId",
        "credentialVersion",
        "model",
        "reasoningEffort",
        "repo",
        "prompt",
        "size",
      ];
      if (
        !selected ||
        typeof selected !== "object" ||
        Array.isArray(selected) ||
        Object.keys(selected).some((field) => !allowed.includes(field)) ||
        typeof selected.model !== "string" ||
        !selected.model.trim() ||
        [selected.repo, selected.reasoningEffort, selected.prompt].some(
          (value) => value !== undefined && (typeof value !== "string" || !value.trim()),
        )
      )
        throw new Error("Invalid child launch selection.");
      if (selected.size !== undefined) parseMachineSize(selected.size);
    }
    // Canonical field inventory, not user JSON key order; omit absent optional fields explicitly.
    const body =
      input.action === "launch"
        ? [
            input.selection.goldenId,
            input.selection.harness,
            input.selection.credentialId,
            input.selection.credentialVersion,
            input.selection.model,
            input.selection.reasoningEffort ?? null,
            input.selection.repo ?? null,
            input.selection.prompt ?? null,
            input.selection.size ?? null,
          ]
        : [
            input.sandboxId,
            input.action === "message" ? input.text : input.action === "extend" ? input.ttlSeconds : null,
          ];
    const digest = createHash("sha256")
      .update(JSON.stringify([input.action, body]))
      .digest("hex");
    const request =
      input.action === "launch"
        ? { ...input.selection, method: "launch" }
        : { method: input.action, childId: input.sandboxId };
    const receipt = await authority.admit(token, request, async (tx, principal) => {
      const prior = (
        await tx.query<{ id: string; state: string; request_digest: string; target_id: string }>(
          `select id,state,request_digest,target_id from public.orchestrator_child_operations
           where orchestrator_id=$1 and action=$2 and idempotency_key=$3 and scope_target=$4`,
          [
            principal.orchestratorId,
            input.action,
            key,
            input.action === "launch" ? principal.orchestratorId : input.sandboxId,
          ],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_digest !== digest) throw new Error("Idempotency conflict.");
        return { id: prior.id, state: prior.state, sandboxId: prior.target_id, fresh: false };
      }
      const parent = (
        await tx.query<{ lifecycle_generation: string; parent_epoch: string; max_active_children: number | null }>(
          `select s.lifecycle_generation,o.authority_epoch as parent_epoch,l.max_active_children from public.orchestrators o
           join public.sandboxes s on s.id=o.sandbox_id
           left join public.orchestrator_lifecycle l on l.orchestrator_id=o.id where o.id=$1`,
          [principal.orchestratorId],
        )
      ).rows[0];
      if (!parent) throw new Error("Parent unavailable.");
      if (input.action === "launch" && parent.max_active_children !== null) {
        const count = (
          await tx.query<{ count: string }>(
            `select count(*) as count from (
              select c.sandbox_id from public.orchestrator_children c join public.sandboxes s on s.id=c.sandbox_id
                where c.orchestrator_id=$1 and s.status not in ('stopped','deleted') and not (s.status='failed' and s.stopped_at is not null)
              union select target_id from public.orchestrator_child_operations
                where orchestrator_id=$1 and action='launch' and state in ('pending','uncertain')
            ) active`,
            [principal.orchestratorId],
          )
        ).rows[0];
        if (!count || Number(count.count) >= parent.max_active_children) throw new Error("Owner child policy reached.");
      }
      const id = crypto.randomUUID();
      const target = input.action === "launch" ? crypto.randomUUID() : input.sandboxId;
      await tx.query(
        `insert into public.orchestrator_child_operations
          (id,orchestrator_id,owner_id,org_id,parent_generation,action,target_id,idempotency_key,request_digest,scope_target,parent_epoch)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          principal.orchestratorId,
          principal.ownerId,
          principal.orgId,
          parent.lifecycle_generation,
          input.action,
          target,
          key,
          digest,
          input.action === "launch" ? principal.orchestratorId : input.sandboxId,
          parent.parent_epoch,
        ],
      );
      // Children have independent receipts; never invalidate a pending owner prompt's revision.
      await tx.query(
        `insert into public.orchestrator_lifecycle(orchestrator_id,last_activity_at,reason)
        values($1,clock_timestamp(),'child_operation') on conflict(orchestrator_id) do update set
        last_activity_at=clock_timestamp(),observation_state='unknown',reason='child_operation',reconcile_after=clock_timestamp()`,
        [principal.orchestratorId],
      );
      return { id, state: "pending", sandboxId: target, fresh: true };
    });
    if (!receipt.fresh) return { id: receipt.id, state: receipt.state, sandboxId: receipt.sandboxId };
    // Claim dispatch once durably. A crash after this point is uncertain, never a fresh launch.
    let row:
      | {
          id: string;
          orchestrator_id: string;
          owner_id: string;
          org_id: string;
          parent_generation: string;
          parent_epoch: string;
          target_id: string;
          action: ChildOperation["action"];
        }
      | undefined;
    try {
      row = await authority.admit(
        token,
        request,
        async (tx) =>
          (
            await tx.query<{
              id: string;
              orchestrator_id: string;
              owner_id: string;
              org_id: string;
              parent_generation: string;
              parent_epoch: string;
              target_id: string;
              action: ChildOperation["action"];
            }>(
              `update public.orchestrator_child_operations set dispatched_at=now()
         where id=$1 and dispatched_at is null and state='pending'
         returning id,orchestrator_id,owner_id,org_id,parent_generation,parent_epoch,target_id,action`,
              [receipt.id],
            )
          ).rows[0],
      );
    } catch {
      // No executor was invoked: failed fresh admission is confirmed non-allocation,
      // not an unknown provider outcome. Current epoch/scope/account is checked again.
      await sql.query(
        `update public.orchestrator_child_operations set state='failed',error_code='child_dispatch_not_admitted' where id=$1 and state='pending'`,
        [receipt.id],
      );
      return { id: receipt.id, state: "failed", sandboxId: receipt.sandboxId };
    }
    if (!row) return { id: receipt.id, state: "uncertain", sandboxId: receipt.sandboxId };
    const operation: ChildOperation = {
      id: row.id,
      orchestratorId: row.orchestrator_id,
      ownerId: row.owner_id,
      orgId: row.org_id,
      parentGeneration: String(row.parent_generation),
      parentEpoch: String(row.parent_epoch),
      sandboxId: row.target_id,
      action: row.action,
    };
    try {
      if (input.action === "launch") {
        const result = await executor.launch(operation, input.selection);
        // Store the physical receipt even if a later membership/generation check fails.
        await sql.query(`update public.orchestrator_child_operations set provider_sandbox_id=$2 where id=$1`, [
          row.id,
          result.providerSandboxId,
        ]);
        if (!sql.transaction) throw new Error("Transactional child completion unavailable.");
        await sql.transaction(async (tx) => {
          const child = (
            await tx.query(
              `select id from public.sandboxes where id=$1 and owner_id=$2 and org_id=$3
            and provider_sandbox_id=$4 for update`,
              [row.target_id, row.owner_id, row.org_id, result.providerSandboxId],
            )
          ).rows[0];
          if (!child) throw new Error("Child allocation receipt does not match persisted identity.");
          const existing = (
            await tx.query<{ orchestrator_id: string }>(
              `select orchestrator_id from public.orchestrator_children where sandbox_id=$1`,
              [row.target_id],
            )
          ).rows[0];
          if (existing && existing.orchestrator_id !== row.orchestrator_id)
            throw new Error("Child belongs to another parent.");
          await tx.query(
            `insert into public.orchestrator_children(sandbox_id,orchestrator_id,org_id,owner_id)
            values($1,$2,$3,$4) on conflict(sandbox_id) do nothing`,
            [row.target_id, row.orchestrator_id, row.org_id, row.owner_id],
          );
        });
      } else if (input.action === "message") await executor.message(operation, input.text);
      else if (input.action === "extend") {
        if (!executor.extend) throw new Error("Child extension unavailable.");
        await executor.extend(operation, input.ttlSeconds);
      } else await executor.stop(operation);
      const completed = await sql.query(
        `update public.orchestrator_child_operations c set state='succeeded',error_code=null
        from public.orchestrators o,public.sandboxes s where c.id=$1 and o.id=c.orchestrator_id
        and s.id=o.sandbox_id and s.lifecycle_generation=c.parent_generation and o.state='ready' and c.state in ('pending','uncertain') returning c.id`,
        [row.id],
      );
      if (!completed.rows.length) {
        const existing = (
          await sql.query<{ state: string }>(`select state from public.orchestrator_child_operations where id=$1`, [
            row.id,
          ])
        ).rows[0];
        if (existing && ["succeeded", "failed"].includes(existing.state))
          return { id: row.id, state: existing.state, sandboxId: row.target_id };
        throw new Error("Child completion generation changed.");
      }
      return { id: row.id, state: "succeeded", sandboxId: row.target_id };
    } catch (error) {
      const noAllocation = input.action === "launch" && error instanceof ChildLaunchNotAllocated;
      const state = noAllocation ? "failed" : "uncertain";
      await sql.query(
        `update public.orchestrator_child_operations set state=$2,error_code=$3 where id=$1 and state in ('pending','uncertain')`,
        [row.id, state, noAllocation ? `child_${error.reason}` : "child_outcome_unconfirmed"],
      );
      const current = (
        await sql.query<{ state: string }>(`select state from public.orchestrator_child_operations where id=$1`, [
          row.id,
        ])
      ).rows[0];
      return { id: row.id, state: current?.state ?? state, sandboxId: row.target_id };
    }
  }
  return {
    /** One bounded receipt-discovery batch, reusable in the existing server lane.
     * No provider create, prompt replay or globally frozen allocation queue. */
    drain: operations.drain,
    async reconcileOne(signal?: AbortSignal): Promise<boolean> {
      signal?.throwIfAborted();
      const lease = crypto.randomUUID();
      const row = (
        await sql.query<{
          id: string;
          orchestrator_id: string;
          owner_id: string;
          org_id: string;
          parent_generation: string;
          parent_epoch: string;
          action: ChildOperation["action"];
          target_id: string;
          provider_sandbox_id: string | null;
        }>(
          `update public.orchestrator_child_operations set reconcile_lease=$1,reconcile_until=now()+interval '2 minutes'
        where id=(select id from public.orchestrator_child_operations where state in ('pending','uncertain')
          and reconcile_after<=now() and (reconcile_until is null or reconcile_until<now())
          order by created_at for update skip locked limit 1)
        returning id,orchestrator_id,owner_id,org_id,parent_generation,parent_epoch,action,target_id,provider_sandbox_id`,
          [lease],
        )
      ).rows[0];
      if (!row) return false;
      const operation: ChildOperation = {
        id: row.id,
        orchestratorId: row.orchestrator_id,
        ownerId: row.owner_id,
        orgId: row.org_id,
        parentGeneration: String(row.parent_generation),
        parentEpoch: String(row.parent_epoch),
        action: row.action,
        sandboxId: row.target_id,
      };
      let state = "uncertain";
      let noAllocation = false;
      let closedProviderId: string | null = null;
      try {
        const found = await operations.run(() => executor.reconcile(operation, signal), signal);
        if (found.operationId !== row.id || found.sandboxId !== row.target_id)
          throw Error("Uncorrelated child receipt.");
        noAllocation = found.noAllocation === true && found.providerSandboxId === undefined;
        closedProviderId = found.resourceStopped === true && found.providerSandboxId ? found.providerSandboxId : null;
        if (
          found.state === "failed" &&
          (row.action !== "launch" ||
            (noAllocation && row.provider_sandbox_id === null) ||
            (closedProviderId !== null && closedProviderId === row.provider_sandbox_id))
        )
          state = "failed";
        if (found.state === "succeeded") {
          if (row.action === "launch") {
            if (!found.providerSandboxId || !sql.transaction) throw Error("Launch receipt missing.");
            await sql.transaction(async (tx) => {
              const child = (
                await tx.query(
                  `select id from public.sandboxes where id=$1 and owner_id=$2 and org_id=$3
                and provider_sandbox_id=$4 for update`,
                  [row.target_id, row.owner_id, row.org_id, found.providerSandboxId],
                )
              ).rows[0];
              if (!child) throw Error("Child identity not confirmed.");
              const existing = (
                await tx.query<{ orchestrator_id: string }>(
                  `select orchestrator_id from public.orchestrator_children where sandbox_id=$1`,
                  [row.target_id],
                )
              ).rows[0];
              if (existing && existing.orchestrator_id !== row.orchestrator_id)
                throw new Error("Child belongs to another parent.");
              await tx.query(
                `insert into public.orchestrator_children(sandbox_id,orchestrator_id,org_id,owner_id)
                values($1,$2,$3,$4) on conflict(sandbox_id) do nothing`,
                [row.target_id, row.orchestrator_id, row.org_id, row.owner_id],
              );
              await tx.query(`update public.orchestrator_child_operations set provider_sandbox_id=$2 where id=$1`, [
                row.id,
                found.providerSandboxId,
              ]);
            });
          }
          state = "succeeded";
        }
      } catch {
        /* Unknown cannot become confirmed non-allocation. */
      }
      await sql.query(
        `update public.orchestrator_child_operations set state=case when $3='uncertain' and state='pending' then state else $3 end,
        error_code=case when $3='uncertain' then 'child_outcome_unconfirmed' else null end,
        reconcile_lease=null,reconcile_until=null,reconcile_after=now()+interval '1 minute'
        where id=$1 and reconcile_lease=$2 and reconcile_until>now() and state in ('pending','uncertain')
        and ($3<>'failed' or action<>'launch' or (provider_sandbox_id is null and $4::boolean)
          or ($5::text is not null and provider_sandbox_id=$5))`,
        [row.id, lease, state, noAllocation, closedProviderId],
      );
      // A delayed observation must never rewrite a confirmed terminal outcome.
      await sql.query(
        `update public.orchestrator_child_operations set reconcile_lease=null,reconcile_until=null
        where id=$1 and reconcile_lease=$2 and state in ('succeeded','failed')`,
        [row.id, lease],
      );
      return true;
    },
    launch: (token: string, key: string, selection: ChildLaunchSelection) =>
      mutate(token, key, { action: "launch", selection }),
    message: (token: string, key: string, sandboxId: string, text: string) =>
      mutate(token, key, { action: "message", sandboxId, text }),
    stop: (token: string, key: string, sandboxId: string) => mutate(token, key, { action: "stop", sandboxId }),
    extend: (token: string, key: string, sandboxId: string, ttlSeconds: number) =>
      mutate(token, key, { action: "extend", sandboxId, ttlSeconds }),
    async read(token: string, sandboxId: string): Promise<unknown> {
      const identity = await authority.admit(token, { method: "read", childId: sandboxId }, async (_tx, p) => p);
      return executor.read(sandboxId, identity.ownerId, identity.orgId);
    },
  };
}
