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
} from "@armada/core/server";
import { createSqlData, type ServerSandboxPatch } from "./data.ts";
import { captureDockerStopOutputs } from "./docker-outputs.ts";
import type { AdmitModalLaunch } from "./modal-launch-admission.ts";
import { isPrivateModelEvent } from "./model-usage.ts";
import { modalDialoutPlacement, usesDiskStopJob } from "./provider-runtime-admission.ts";
import type { RuntimeCheckpoint } from "./runtime-checkpoint.ts";
import { runtimeTransaction } from "./runtime-enrolment.ts";
import type { RuntimeFollowup } from "./runtime-followup.ts";
import { SandboxStopTargetChanged } from "./runtime-reconciliation-conflict.ts";
import { ChildLaunchNotAllocated } from "./sandbox-access-child-launch.ts";
import {
  type ChildOperation,
  ChildStopNotAdmitted,
  createSandboxChildren,
  type SandboxChildExecutor,
  type StopRecoveryAdmission,
} from "./sandbox-access-children.ts";
import { createSandboxScopedGateway } from "./sandbox-access-scoped-gateway.ts";
import { requireGenerationHeadroom } from "./sandbox-activity.ts";
import { extendSandbox } from "./sandbox-extend.ts";
import { createRuntimeSelfFinish, requestSandboxFinish } from "./sandbox-finish.ts";

class DelegatedAccessError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Scoped ordinary-sandbox child operations, with no owner runtime or parent reconciler. */
export function createSandboxAccessServices(input: {
  sql: Sql;
  providers: ProviderRegistry;
  connections: LaunchStores["connections"];
  admitLaunch?: AdmitModalLaunch;
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
            ...(saved.modalTransport ? { modalTransport: saved.modalTransport } : {}),
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
    const { saved } = await child(operation.sandboxId, operation.ownerId, operation.orgId);
    const modalStop = modalDialoutPlacement(saved);
    if (!modalStop && !usesDiskStopJob(saved.provider)) throw new ChildStopNotAdmitted("sandbox_not_ready");
    if (
      admitRecovery &&
      saved.modalTransport === "dialout" &&
      ["stopping", "stopped", "failed"].includes(saved.status)
    ) {
      await admitRecovery(async (tx) => {
        const proof = await tx.query(
          `select 1 from public.sandboxes s join public.jobs j on j.sandbox_id=s.id and j.generation=s.lifecycle_generation
           where s.id=$1 and s.lifecycle_generation=$2 and j.kind='stop' and j.state in ('queued','leased','done')
             and j.outcome->>'modal_child_operation'=$3 and s.status in ('stopping','stopped','failed') for update of s`,
          [saved.id, saved.lifecycleGeneration, operation.id],
        );
        if (!proof.rows.length) throw new DelegatedAccessError("conflict");
      });
      return;
    }
    if (saved.boatRuntime && (saved.status === "stopping" || saved.stopRequestedAt)) return;
    const retained =
      saved.modalTransport === "dialout" || (saved.boatRuntime && ["ready", "running"].includes(saved.status));
    if (admitRecovery && (!retained || !["ready", "running"].includes(saved.status) || saved.stopRequestedAt))
      throw new DelegatedAccessError("conflict");
    if (saved.status === "stopped" || (saved.status === "failed" && saved.stoppedAt)) return;
    const caller = {
      via: "service" as const,
      userId: operation.ownerId,
      orgs: [{ orgId: operation.orgId, role: "member" as const }],
    };
    const scoped = createSqlData(sql)(caller).sandboxes;
    if (!admitRecovery) {
      try {
        if (await scoped.requestStartingModalStop?.(saved)) return;
      } catch (error) {
        if (error instanceof SandboxStopTargetChanged) throw new ChildStopNotAdmitted("stop_target_changed");
        throw error;
      }
      if (saved.status === "starting") throw new ChildStopNotAdmitted("sandbox_not_ready");
    }
    if (saved.lifecycleGeneration === undefined) throw new DelegatedAccessError("conflict");
    const stopGeneration = requireGenerationHeadroom(saved.lifecycleGeneration, 1);
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
    await stopStore.update(saved.id, {
      ...stopAdmission,
      ...(modalStop ? { queueModalStop: operation.id } : {}),
      status: stoppingStatus,
      stopRequested: true,
      statusReason,
      advanceGeneration: true,
      activityToken: crypto.randomUUID(),
      expectedGeneration: stopGeneration,
    });
  }
  const executor: SandboxChildExecutor = {
    async launch(operation, chosen) {
      const { goldenId, credentialVersion, ...selection } = chosen;
      const goldens = await stores.goldens.list(operation.orgId).catch((error) => {
        throw new ChildLaunchNotAllocated("preallocation_rejected", "golden_lookup", error);
      });
      const golden = goldens.find((candidate) => candidate.id === goldenId);
      if (!golden) throw new ChildLaunchNotAllocated("preallocation_rejected", "golden_lookup");
      if (!input.admitLaunch) throw new ChildLaunchNotAllocated("preallocation_rejected", "provider_placement");
      const actor = { userId: operation.ownerId, orgId: operation.orgId, role: "member" as const };
      await input.admitLaunch(
        actor,
        golden,
        stores,
        { ...selection, golden: golden.name, provider: golden.provider },
        { child: { operation, credentialVersion } },
      );
    },
    async read(id, ownerId, orgId) {
      const { saved, resolveProvider } = await child(id, ownerId, orgId);
      if (saved.status === "starting" || !saved.providerSandboxId)
        return {
          ...saved,
          providerSandboxId: saved.providerSandboxId || null,
          events: [],
          cursor: null,
          hasMore: false,
        };
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
      const { saved } = await child(operation.sandboxId, operation.ownerId, operation.orgId);
      const actor = { userId: operation.ownerId, orgId: operation.orgId, role: "member" as const };
      if (!input.runtimeSend) throw new DelegatedAccessError("unavailable");
      await input.runtimeSend(
        { userId: actor.userId, orgs: [{ orgId: actor.orgId, role: actor.role }], via: "service" },
        { id: saved.id, prompt: text, request_id: operation.id },
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
      await provider.get(saved.providerSandboxId, { ...(signal ? { signal } : {}) });
      return {
        operationId: operation.id,
        sandboxId: operation.sandboxId,
        // A provider observation does not establish the outcome of an exact mutation.
        state: "unknown",
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
