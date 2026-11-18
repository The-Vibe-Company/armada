import type { LaunchStores } from "@armada/core/server";
import {
  createSqlGoldenStore,
  createSqlSandboxStore,
  createSqlVaultStore,
  DelegatedAuthority,
  mapSandboxRow,
  type ProviderRegistry,
  resolveCredentials,
  type SandboxRow,
  type Sql,
  sandboxActivity,
} from "@armada/core/server";
import { createSqlData } from "./data.ts";
import { captureDockerStopOutputs } from "./docker-outputs.ts";
import { isPrivateModelEvent } from "./model-usage.ts";
import type { NamedLaunchCredentials } from "./named-credentials.ts";
import { recordOperatorFailure } from "./request-observability.ts";
import { launchSandboxChild } from "./sandbox-access-child-launch.ts";
import type { SandboxChildExecutor } from "./sandbox-access-children.ts";
import { createSandboxChildren } from "./sandbox-access-children.ts";
import { createSandboxScopedGateway } from "./sandbox-access-scoped-gateway.ts";
import { extendSandbox } from "./sandbox-extend.ts";
import { createRuntimeSelfFinish, requestSandboxFinish } from "./sandbox-finish.ts";
import { preserveBeforeStop, recordStopDispatch } from "./work-preservation.ts";

class DelegatedAccessError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Scoped ordinary-sandbox child operations, with no owner runtime or parent reconciler. */
export function createSandboxAccessServices(input: {
  extensionHeadroomSeconds?: number;
  sql: Sql;
  providers: ProviderRegistry;
  credentials: NamedLaunchCredentials;
  connections: LaunchStores["connections"];
  encryptionKey: string;
  scopedMcpUrl: string;
  /** Docker final output capture before agent-finished stops (tests inject the runtime reader). */
  outputs?: Parameters<typeof captureDockerStopOutputs>[3];
}) {
  const { sql } = input;
  const authority = new DelegatedAuthority(sql, async (tx, account) => {
    // The actual named credential policy under the authority transaction, never
    // owner API impersonation or a cached account/version decision.
    await resolveCredentials(createSqlVaultStore(tx), input.encryptionKey, account);
  });
  const stores = {
    goldens: createSqlGoldenStore(sql),
    sandboxes: createSqlSandboxStore(sql, { turnModels: true }),
    credentials: input.credentials,
    ...(input.connections ? { connections: input.connections } : {}),
  };
  async function child(sandboxId: string, ownerId: string, orgId: string) {
    const row = (
      await sql.query<SandboxRow & { source_golden_visibility: "org" | "private" }>(
        `select s.* from public.sandboxes s join public.orchestrator_children c on c.sandbox_id=s.id
       join public.members m on m.org_id=c.org_id and m.user_id=c.owner_id
       where s.id=$1 and s.owner_id=$2 and s.org_id=$3 and c.owner_id=s.owner_id and c.org_id=s.org_id
       and not exists(select 1 from public.armada_access_parents o where o.sandbox_id=s.id)`,
        [sandboxId, ownerId, orgId],
      )
    ).rows[0];
    if (!row) throw new DelegatedAccessError("not_found");
    const saved = mapSandboxRow(row);
    const golden = (await stores.goldens.list(orgId)).find((g) => g.id === saved.goldenId);
    if (!golden) throw new DelegatedAccessError("not_found");
    const provider = await input.providers.resolve(
      {
        provider: saved.provider,
        orgId,
        visibility: saved.visibility ?? golden.visibility,
        sourceGoldenVisibility: row.source_golden_visibility,
        modal: golden.modal,
      },
      { userId: ownerId },
    );
    return { saved, provider };
  }
  const executor: SandboxChildExecutor = {
    async launch(operation, chosen) {
      const golden = (await stores.goldens.list(operation.orgId)).find((g) => g.id === chosen.goldenId);
      if (!golden) throw new DelegatedAccessError("not_found");
      return launchSandboxChild({
        sql,
        operation,
        selection: chosen,
        ...(input.extensionHeadroomSeconds === undefined
          ? {}
          : { extensionHeadroomSeconds: input.extensionHeadroomSeconds }),
        stores: {
          ...stores,
          // Children are ordinary sandboxes: initialization owns the same activity
          // lease as a public launch. The legacy service store does not fence the
          // lifecycle observer, which otherwise treats "starting" as abandoned.
          sandboxes: createSqlData(sql)({
            via: "service",
            userId: operation.ownerId,
            orgs: [{ orgId: operation.orgId, role: "member" }],
          }).sandboxes,
          goldens: new Proxy(stores.goldens, {
            get(target, key) {
              if (key === "findByName")
                return async (orgId: string, name: string) =>
                  (await target.findByName(orgId, name)).filter((candidate) => candidate.id === chosen.goldenId);
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        },
        namedCredentials: input.credentials,
        provider: await input.providers.resolve(golden, { userId: operation.ownerId }),
      });
    },
    async read(id, ownerId, orgId) {
      const { saved, provider } = await child(id, ownerId, orgId);
      const events = await provider.events({ sandboxId: saved.providerSandboxId, direction: "backward", limit: 100 });
      return {
        ...saved,
        events: events.events.filter((event) => !isPrivateModelEvent(event)),
        cursor: events.cursor ?? null,
        hasMore: events.hasMore,
      };
    },
    async message(operation, text) {
      const { saved, provider } = await child(operation.sandboxId, operation.ownerId, operation.orgId);
      const actor = { userId: operation.ownerId, orgId: operation.orgId, role: "member" as const };
      await input.credentials.assertTurn?.(actor, saved.id, saved.status === "stopped");
      const scoped = createSqlData(sql)({
        via: "service",
        userId: operation.ownerId,
        orgs: [{ orgId: operation.orgId, role: "member" }],
      }).sandboxes;
      // Explicit new work cancels the pending stop epoch under the same activity
      // fences used by ordinary send, so an older receipt cannot cover this turn.
      // Clear the previous report under the same fence as ordinary send, so publishing
      // the new prompt identity cannot re-announce the earlier turn's outcome.
      await sandboxActivity(
        scoped,
        saved,
        { status: "running", stopRequested: false, clearTaskOutcome: true },
        async (signal) => {
          const receipt = await provider.prompt({
            sandboxId: saved.providerSandboxId,
            harness: saved.harness,
            text,
            signal,
            ...(saved.model ? { model: saved.model } : {}),
            ...(saved.reasoningEffort ? { reasoningEffort: saved.reasoningEffort } : {}),
            ...(saved.conversationIds.at(-1) ? { conversationId: saved.conversationIds.at(-1)! } : {}),
          });
          // Register the accepted identity exactly like ordinary send, so the native
          // receipt worker and lifecycle reconciliation settle (and export) this turn.
          await scoped.recordNativePrompt?.(saved.id, saved.providerSandboxId, receipt.promptId);
          try {
            await stores.sandboxes.recordTurnModel?.(saved.id, receipt.promptId, saved.model);
          } catch (error) {
            // The accepted prompt continues; the structured line carries the request and sandbox IDs.
            recordOperatorFailure("sandbox_access.send.turn_model_record", error, { sandboxId: saved.id });
          }
          return {
            result: undefined,
            patch: {
              status: "running",
              taskPromptId: receipt.promptId,
              rearmDeadline: true,
              conversationIds: [...new Set([...saved.conversationIds, receipt.conversationId])],
            },
          };
        },
      );
    },
    async extend(operation, ttlSeconds) {
      const { saved, provider } = await child(operation.sandboxId, operation.ownerId, operation.orgId);
      const scoped = createSqlData(input.sql)({
        via: "service",
        userId: operation.ownerId,
        orgs: [{ orgId: operation.orgId, role: "member" }],
      });
      await extendSandbox(
        scoped.sandboxes,
        saved,
        provider,
        ttlSeconds,
        () => input.connections?.renewLifetime?.(provider, saved.id) ?? Promise.resolve(),
      );
    },
    async stop(operation) {
      const { saved, provider } = await child(operation.sandboxId, operation.ownerId, operation.orgId);
      const scoped = createSqlData(sql)({
        via: "service",
        userId: operation.ownerId,
        orgs: [{ orgId: operation.orgId, role: "member" }],
      }).sandboxes;
      await sandboxActivity(
        scoped,
        saved,
        { status: "stopping", stopRequested: true, statusReason: null },
        async () => {
          if (
            (await preserveBeforeStop(
              input.sql,
              provider,
              saved.id,
              saved.providerSandboxId,
              "managed_child_stop",
            ).catch(() => {})) === "pending"
          )
            return { result: undefined, patch: { status: "stopping", stopRequested: true } };
          recordStopDispatch(saved.id, saved.providerSandboxId, "managed_child_stop");
          await provider.stop({ sandboxId: saved.providerSandboxId });
          // Stop dispatch is not physical closure. Keep pending stops observable by
          // lifecycle recovery, and release the status-read fence only on confirmation.
          const observed = await provider.get(saved.providerSandboxId);
          const terminal = observed.state === "stopped";
          return {
            result: undefined,
            patch: {
              status: terminal ? "stopped" : "stopping",
              stopRequested: !terminal,
              stoppedAt: terminal ? (observed.stoppedAt ?? new Date()).toISOString() : null,
            },
          };
        },
      );
    },
    async reconcile(operation, signal) {
      signal?.throwIfAborted();
      const { saved, provider } = await child(operation.sandboxId, operation.ownerId, operation.orgId);
      const physical = await provider.get(saved.providerSandboxId, { ...(signal ? { signal } : {}) });
      const closed = physical.state === "stopped";
      return {
        operationId: operation.id,
        sandboxId: operation.sandboxId,
        // Current stopped state is closure evidence, NOT proof that this exact
        // message/stop operation succeeded. Never replay an ambiguous mutation.
        state: "unknown",
        providerSandboxId: saved.providerSandboxId,
        ...(operation.action === "launch" && closed ? { resourceStopped: true } : {}),
      };
    },
  };
  const children = createSandboxChildren(sql, authority, executor);
  async function finish(token: string) {
    // Docker: capture declared outputs before the stop is admitted (the runtime then refuses
    // commands). This read-only admission only resolves the target; the real one follows.
    const target = await authority
      .admit(token, { method: "finish" }, async (tx, principal) => {
        const parent = await tx.query<{ sandbox_id: string }>(
          "select sandbox_id from public.armada_access_parents where id=$1 and kind='sandbox'",
          [principal.orchestratorId],
        );
        return parent.rows[0]?.sandbox_id;
      })
      .catch(() => undefined);
    if (target) await captureDockerStopOutputs(sql, input.encryptionKey, target, input.outputs);
    return authority.admit(token, { method: "finish" }, async (tx, principal) => {
      const row = (
        await tx.query<{ sandbox_id: string }>(
          "select sandbox_id from public.armada_access_parents where id=$1 and kind='sandbox'",
          [principal.orchestratorId],
        )
      ).rows[0];
      if (!row) throw new DelegatedAccessError("not_found");
      return requestSandboxFinish(tx, input.encryptionKey, row.sandbox_id, principal.ownerId);
    });
  }
  return {
    scopedToolsRoute: createSandboxScopedGateway(
      children,
      finish,
      createRuntimeSelfFinish(sql, input.encryptionKey, input.outputs),
    ),
    childWorker: children,
  };
}
