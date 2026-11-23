import type { LaunchOptions, LaunchStores } from "@armada/core/server";
import {
  createSqlGoldenStore,
  createSqlSandboxStore,
  createSqlVaultStore,
  DelegatedAuthority,
  mapSandboxRow,
  type ProviderRegistry,
  resolveCredentials,
  type SandboxProviderId,
  type SandboxRow,
  type Sql,
  sandboxActivity,
} from "@armada/core/server";
import { createSqlData, type ServerSandboxPatch } from "./data.ts";
import { captureDockerStopOutputs } from "./docker-outputs.ts";
import { isPrivateModelEvent } from "./model-usage.ts";
import type { NamedLaunchCredentials } from "./named-credentials.ts";
import { recordOperatorFailure } from "./request-observability.ts";
import type { RuntimeCheckpoint } from "./runtime-checkpoint.ts";
import { runtimeTransaction } from "./runtime-enrolment.ts";
import type { RuntimeFollowup } from "./runtime-followup.ts";
import { ChildLaunchNotAllocated, launchSandboxChild } from "./sandbox-access-child-launch.ts";
import {
  ChildMessageNotDispatched,
  type ChildOperation,
  createSandboxChildren,
  type SandboxChildExecutor,
  type StopRecoveryAdmission,
} from "./sandbox-access-children.ts";
import { createSandboxScopedGateway } from "./sandbox-access-scoped-gateway.ts";
import { extendSandbox } from "./sandbox-extend.ts";
import { createRuntimeSelfFinish, requestSandboxFinish } from "./sandbox-finish.ts";
import { preserveBeforeStop, stopAndObserve } from "./work-preservation.ts";

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
  runtimePlacements?: Partial<Record<SandboxProviderId, LaunchOptions["modalRuntimeDefault"]>>;
  boatEndpointRuntime?: LaunchOptions["boatEndpointRuntime"];
  runtimeSend?: RuntimeFollowup;
  runtimeCheckpoint?: RuntimeCheckpoint;
  encryptionKey: string;
  scopedMcpUrl: string;
  configureMutationRequest?: (request: Request) => void;
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
    return {
      saved,
      async resolveProvider() {
        const golden = (await stores.goldens.list(orgId)).find((g) => g.id === saved.goldenId);
        if (!golden) throw new DelegatedAccessError("not_found");
        return input.providers.resolve(
          {
            id: saved.id,
            ...(saved.runtimeTransport ? { runtimeTransport: saved.runtimeTransport } : {}),
            ...(saved.boatRuntime ? { boatRuntime: saved.boatRuntime } : {}),
            provider: saved.provider,
            orgId,
            visibility: saved.visibility ?? golden.visibility,
            sourceGoldenVisibility: row.source_golden_visibility,
            modal: golden.modal,
          },
          { userId: ownerId },
        );
      },
    };
  }
  async function stopChild(operation: ChildOperation, admitRecovery?: StopRecoveryAdmission) {
    const { saved, resolveProvider } = await child(operation.sandboxId, operation.ownerId, operation.orgId);
    if (saved.boatRuntime && (saved.status === "stopping" || saved.stopRequestedAt)) return;
    const retained =
      saved.runtimeTransport === "dialout" || (saved.boatRuntime && ["ready", "running"].includes(saved.status));
    if (admitRecovery && (!retained || !["ready", "running"].includes(saved.status) || saved.stopRequestedAt))
      throw new DelegatedAccessError("conflict");
    if (saved.status === "stopped" || (saved.status === "failed" && saved.stoppedAt)) return;
    const caller = {
      via: "service" as const,
      userId: operation.ownerId,
      orgs: [{ orgId: operation.orgId, role: "member" as const }],
    };
    const scoped = createSqlData(sql)(caller).sandboxes;
    if (!admitRecovery && (await scoped.requestStartingModalStop?.(saved))) return;
    const provider = await resolveProvider();
    let checkpoint: Awaited<ReturnType<RuntimeCheckpoint>> | undefined;
    if (retained) {
      if (!input.runtimeCheckpoint) throw new DelegatedAccessError("unavailable");
      const prior = (
        await sql.query<{ request_id: string; epoch: string }>(
          `select p.request_id,p.epoch::text from public.runtime_checkpoints p join public.runtime_enrolments r
           on r.sandbox_id=p.sandbox_id and r.epoch=p.epoch where p.sandbox_id=$1`,
          [saved.id],
        )
      ).rows[0];
      if (admitRecovery && prior?.request_id !== operation.id) throw new DelegatedAccessError("conflict");
      checkpoint = await input.runtimeCheckpoint(caller, {
        id: saved.id,
        request_id: prior?.request_id ?? operation.id,
        runtimeVersion: 1,
      });
      if (admitRecovery && (checkpoint.requestId !== operation.id || checkpoint.runtime.epoch !== prior?.epoch))
        throw new DelegatedAccessError("conflict");
    }
    const stoppingStatus = saved.status === "failed" ? "failed" : "stopping";
    const statusReason = stoppingStatus === "failed" ? (saved.statusReason ?? null) : retained ? "idle_paused" : null;
    const epoch = checkpoint?.runtime.epoch;
    const stopStore = admitRecovery
      ? {
          ...scoped,
          async update(id: string, patch: Parameters<typeof scoped.update>[1]) {
            if (!patch.advanceGeneration) return scoped.update(id, patch);
            await admitRecovery(async (tx) => {
              const proof = await tx.query(
                `select p.request_id from public.runtime_checkpoints p
                 join public.runtime_enrolments r on r.sandbox_id=p.sandbox_id and r.epoch=p.epoch
                 join public.sandboxes s on s.id=p.sandbox_id
                 where s.id=$1 and p.request_id=$2 and p.epoch=$3 and p.watermark is not null
                 and p.watermark=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=s.id)
                 and r.runtime_hash is not null and r.lifecycle_generation=s.lifecycle_generation
                 and s.status in ('ready','running') and s.stop_requested_at is null and s.deleted_at is null
                 and s.expires_at>clock_timestamp() and not s.application_secret_tainted`,
                [id, operation.id, epoch],
              );
              if (!proof.rows.length) throw new DelegatedAccessError("conflict");
              await createSqlData(runtimeTransaction(tx))(caller).sandboxes.update(id, patch);
            });
          },
        }
      : scoped;
    const stopAdmission: Pick<ServerSandboxPatch, "ownerStop" | "retainedRuntimeStop"> = {
      ownerStop: true,
      ...(checkpoint && stoppingStatus === "stopping" ? { retainedRuntimeStop: checkpoint.requestId } : {}),
    };
    await sandboxActivity(
      stopStore,
      saved,
      { ...stopAdmission, status: stoppingStatus, stopRequested: true, statusReason },
      async (signal, token) => {
        if (saved.provider === "modal" && saved.runtimeTransport === "dialout")
          return {
            result: undefined,
            patch: { ownerStop: true, status: stoppingStatus, stopRequested: true, statusReason },
          };
        if (
          (await preserveBeforeStop(input.sql, provider, saved.id, saved.providerSandboxId, "managed_child_stop", {
            kind: "activity",
            token,
            generation: saved.lifecycleGeneration === undefined ? undefined : saved.lifecycleGeneration + 1,
            signal,
          }).catch(() => "pending" as const)) === "pending"
        )
          return {
            result: undefined,
            patch: { ownerStop: true, status: stoppingStatus, stopRequested: true, statusReason },
          };
        signal.throwIfAborted();
        const observed = await stopAndObserve(
          provider,
          saved.id,
          saved.providerSandboxId,
          "managed_child_stop",
          signal,
          retained,
        );
        const terminal =
          observed.state === "stopped" &&
          (provider.id !== "boat" || observed.retainedSnapshot === "usable" || stoppingStatus === "failed");
        return {
          result: undefined,
          patch: {
            ownerStop: true,
            status: stoppingStatus === "failed" ? "failed" : terminal ? "stopped" : "stopping",
            statusReason,
            stopRequested: !terminal,
            stoppedAt: terminal ? (observed.stoppedAt ?? new Date()).toISOString() : null,
          },
        };
      },
    );
  }
  const executor: SandboxChildExecutor = {
    async launch(operation, chosen) {
      const goldens = await stores.goldens.list(operation.orgId).catch((error) => {
        throw new ChildLaunchNotAllocated("preallocation_rejected", "golden_lookup", error);
      });
      const golden = goldens.find((g) => g.id === chosen.goldenId);
      if (!golden) throw new ChildLaunchNotAllocated("preallocation_rejected", "golden_lookup");
      let placement = input.runtimePlacements?.[golden.provider];
      if (!placement) {
        const enrolledBoatParent = (
          await sql.query(
            `select p.id from public.armada_access_parents p
             join public.sandboxes s on s.id=p.sandbox_id
             where p.id=$1 and p.owner_id=$2 and p.org_id=$3 and s.provider=$4 and s.boat_runtime`,
            [operation.orchestratorId, operation.ownerId, operation.orgId, golden.provider],
          )
        ).rows[0];
        if (enrolledBoatParent) {
          placement = input.boatEndpointRuntime;
          if (!placement) throw new ChildLaunchNotAllocated("preallocation_rejected", "provider_placement");
        }
      }
      const actor = { userId: operation.ownerId, orgId: operation.orgId, role: "member" as const };
      const credentials = placement?.credentials ?? input.credentials;
      const privateTarget = { ...golden, visibility: "private" as const, sourceGoldenVisibility: golden.visibility };
      const provider = await (placement
        ? placement.provider(actor, privateTarget)
        : input.providers.resolve(golden, { userId: actor.userId })
      ).catch((error) => {
        throw new ChildLaunchNotAllocated("preallocation_rejected", "provider_placement", error);
      });
      return launchSandboxChild({
        sql,
        operation,
        selection: chosen,
        ...(input.extensionHeadroomSeconds === undefined
          ? {}
          : { extensionHeadroomSeconds: input.extensionHeadroomSeconds }),
        stores: {
          ...stores,
          credentials,
          ...(placement ? { connections: placement.connections } : {}),
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
        namedCredentials: credentials,
        ...(placement ? { runtime: placement.policy } : {}),
        provider,
      });
    },
    async read(id, ownerId, orgId) {
      const { saved, resolveProvider } = await child(id, ownerId, orgId);
      const provider = await resolveProvider();
      const events = await provider.events({ sandboxId: saved.providerSandboxId, direction: "backward", limit: 100 });
      return {
        ...saved,
        events: events.events.filter((event) => !isPrivateModelEvent(event)),
        cursor: events.cursor ?? null,
        hasMore: events.hasMore,
      };
    },
    async message(operation, text) {
      const { saved, resolveProvider } = await child(operation.sandboxId, operation.ownerId, operation.orgId);
      const actor = { userId: operation.ownerId, orgId: operation.orgId, role: "member" as const };
      if (saved.runtimeTransport || saved.boatRuntime) {
        if (!input.runtimeSend) throw new DelegatedAccessError("unavailable");
        await input.runtimeSend(
          { userId: actor.userId, orgs: [{ orgId: actor.orgId, role: actor.role }], via: "service" },
          { id: saved.id, prompt: text, request_id: operation.id },
        );
        return;
      }
      await input.credentials.assertTurn?.(actor, saved.id, saved.status === "stopped");
      const provider = await resolveProvider();
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
        {
          ...scoped,
          async update(id, patch) {
            if (!patch.advanceGeneration) return scoped.update(id, patch);
            try {
              await scoped.update(id, {
                ...patch,
                nativeChildSend: { fromState: saved.status, placement: saved.providerSandboxId },
              });
            } catch (cause) {
              throw new ChildMessageNotDispatched("Native child send admission failed.", { cause });
            }
          },
        },
        saved,
        { statusReason: null, stopRequested: false, clearTaskOutcome: true },
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
          const patch: ServerSandboxPatch = {
            nativeSendReceipt: { fromState: "running", placement: saved.providerSandboxId },
            statusReason: null,
            taskPromptId: receipt.promptId,
            rearmDeadline: true,
            conversationIds: [...new Set([...saved.conversationIds, receipt.conversationId])],
          };
          return {
            result: undefined,
            patch,
          };
        },
      );
    },
    async extend(operation, ttlSeconds) {
      const { saved, resolveProvider } = await child(operation.sandboxId, operation.ownerId, operation.orgId);
      const provider = await resolveProvider();
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
    stop: stopChild,
    recoverStop: stopChild,
    async reconcile(operation, signal) {
      signal?.throwIfAborted();
      const { saved, resolveProvider } = await child(operation.sandboxId, operation.ownerId, operation.orgId);
      const provider = await resolveProvider();
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
      authority,
      finish,
      createRuntimeSelfFinish(sql, input.encryptionKey, input.outputs),
      input.configureMutationRequest,
    ),
    childWorker: children,
    authority,
  };
}
