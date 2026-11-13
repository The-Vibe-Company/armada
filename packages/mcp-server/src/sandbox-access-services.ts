import type { LaunchStores } from "@armada/core/server";
import {
  createSqlGoldenStore,
  createSqlSandboxStore,
  createSqlVaultStore,
  DelegatedAuthority,
  mapSandboxRow,
  ProviderError,
  type ProviderRegistry,
  resolveCredentials,
  type SandboxRow,
  type Sql,
  sandboxActivity,
} from "@armada/core/server";
import { createSqlData } from "./data.ts";
import { isPrivateModelEvent } from "./model-usage.ts";
import type { NamedLaunchCredentials } from "./named-credentials.ts";
import { launchSandboxChild } from "./sandbox-access-child-launch.ts";
import type { SandboxChildExecutor } from "./sandbox-access-children.ts";
import { createSandboxChildren } from "./sandbox-access-children.ts";
import { createSandboxScopedGateway } from "./sandbox-access-scoped-gateway.ts";
import { extendSandbox } from "./sandbox-extend.ts";
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
      await sandboxActivity(scoped, saved, { status: "running", stopRequested: false }, async (signal) => {
        const receipt = await provider.prompt({
          sandboxId: saved.providerSandboxId,
          harness: saved.harness,
          text,
          signal,
          ...(saved.model ? { model: saved.model } : {}),
          ...(saved.reasoningEffort ? { reasoningEffort: saved.reasoningEffort } : {}),
          ...(saved.conversationIds.at(-1) ? { conversationId: saved.conversationIds.at(-1)! } : {}),
        });
        try {
          await stores.sandboxes.recordTurnModel?.(saved.id, receipt.promptId, saved.model);
        } catch {
          try {
            console.error("armada: turn model request record unavailable; accepted prompt continues.");
          } catch {
            /* Logging must not change accepted work. */
          }
        }
        return {
          result: undefined,
          patch: {
            status: "running",
            rearmDeadline: true,
            conversationIds: [...new Set([...saved.conversationIds, receipt.conversationId])],
          },
        };
      });
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
      await sandboxActivity(stores.sandboxes, saved, { stopRequested: true }, async () => {
        if (
          (await preserveBeforeStop(input.sql, provider, saved.id, saved.providerSandboxId, "managed_child_stop").catch(
            () => {},
          )) === "pending"
        )
          throw new ProviderError({
            provider: provider.id,
            code: "sandbox_not_ready",
            retryable: true,
            message: "Interruption is pending; retry stop after turns settle.",
          });
        recordStopDispatch(saved.id, saved.providerSandboxId, "managed_child_stop");
        await provider.stop({ sandboxId: saved.providerSandboxId });
        return { result: undefined, patch: { status: "stopped", stoppedAt: new Date().toISOString() } };
      });
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
  return { scopedToolsRoute: createSandboxScopedGateway(children), childWorker: children };
}
