import { sha256Hex } from "@armada/auth";
import type { AccountPool, AccountSkip } from "@armada/core";
import {
  EncryptionKeyError,
  type GoldenActor,
  type GoldenRecord,
  HARNESS_KINDS,
  type Harness,
  MACHINE_SIZES,
  type MemberRole,
  type ModalBinding,
  ProviderError,
  parseGoldenConfig,
  type SandboxStatus,
  validateSkillPins,
} from "@armada/core";
import type { ModalLaunchReceipt } from "@armada/core/contract";
import {
  assertLaunchSecretBindings,
  createSqlSandboxStore,
  createSqlVaultStore,
  decryptSecret,
  failureDiagnostic,
  GOLDEN_ROOT,
  GoldenError,
  isNonMutatingProviderRefusal,
  LaunchError,
  type Machine,
  type MachineIdentity,
  type MachineIncarnation,
  PrivateSkillError,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { createModalMachine, type ModalMachineOptions, scopeKey } from "@armada/provider-modal";
import { z } from "zod";
import { lockAndCheckStartingLaunchAccount } from "../account-capacity.ts";
import type { AccountTurnQueue } from "../account-turn-queue.ts";
import type { Caller } from "../caller.ts";
import type { createGoldenRuntimeEnvironment } from "../golden-runtime-environment.ts";
import { admitAccount } from "../launch-account-pool.ts";
import { launchCredentials } from "../launch-credentials.ts";
import {
  type ModalLaunchHandoff,
  type ModalLaunchPlacement,
  prepareModalLaunchHandoff,
} from "../modal-launch-handoff.ts";
import {
  freshBoatAdmission,
  type OrdinaryLaunchFailure,
  ordinaryLaunchFingerprint,
  replayOrdinaryLaunchFailure,
} from "../ordinary-launch-receipts.ts";
import { recordOperatorDiagnostic, recordOperatorFailure } from "../request-observability.ts";
import { recordModalLaunchAdmission } from "../request-timing.ts";
import { runtimeAgentFor, workspaceCommandId } from "../runtime-agent.ts";
import { RuntimeCommandRefused } from "../runtime-commands.ts";
import type { RuntimeConfigurationTarget } from "../runtime-configuration.ts";
import {
  createRuntimeEnrolments,
  RuntimeEnrolmentDenied,
  type RuntimeTicketGuard,
  scopedRuntimeSql,
} from "../runtime-enrolment.ts";
import { type RuntimeGitHub, RuntimeGitHubDeliveryError } from "../runtime-github.ts";
import { pinnedMcpConnections, type RuntimeMcp } from "../runtime-mcp.ts";
import { readRuntimeTemplateEnvironment } from "../runtime-readable-variables.ts";
import { runtimeWorkspace } from "../runtime-workspace.ts";
import { SCOPED_REFERENCE_STEP, sandboxAccessReferenceCommand } from "../sandbox-access-bootstrap.ts";
import {
  ChildLaunchNotAllocated,
  childLaunchLockBudget,
  completeChildLaunchAdmission,
  lockChildLaunchAdmission,
} from "../sandbox-access-child-launch.ts";
import type { ChildOperation } from "../sandbox-access-children.ts";
import {
  type RestoreScopedRuntimeAccess,
  registerSandboxArmadaParent,
  type SandboxArmadaAccessOptions,
} from "../sandbox-armada-access.ts";
import {
  bindModalLaunchMachine,
  clearStartingModalStop,
  insertStartingModalSandbox,
  type ModalLaunchSandbox,
  recordFailedModalLaunchExit,
  taintStartingModalSandbox,
  transitionSandbox,
} from "../sandbox-lifecycle.ts";
import { publicSandboxStatusSql } from "../sandbox-readiness.ts";
import { MODAL_LAUNCH_FAILURE } from "../turns.ts";
import { enqueueLaunch } from "./launch.ts";
import { modalLaunchSetupTimer, parseModalLaunchWorkspace } from "./modal-launch-setup.ts";
import type { Job, JobContext, JobKind, JobResult } from "./runner.ts";
import {
  adoptObservedModalAllocation,
  ConflictingJobRequest,
  clearRefusedBoatCreate,
  createJobsStore,
  jobRequestKey,
  queryWithJobLease,
  recordModalBootstrapTicket,
  wakeEnrolledSandboxJobs,
  wakeSandboxJobs,
  withJobLease,
} from "./store.ts";
import { launchAuthorityCurrent } from "./template-launch-authority.ts";

export type ModalLaunchAllocation = Omit<Parameters<Machine["create"]>[0], "sandboxId" | "generation" | "signal">;
export interface ModalLaunchAdmission {
  boat?: BoatAuthority;
  orgId: string;
  ownerId: string;
  request?: { key: string; payload: unknown };
  templateReceiptId?: string;
  child?: ChildOperation;
  revalidateTemplate?(tx: Sql): Promise<void>;
  sandbox: ModalLaunchSandbox;
  accountPool?: {
    pool: AccountPool;
    prepared: ReadonlyMap<string, { credentialVersion: number; model: string; reasoningEffort: string }>;
  };
  allocation: Omit<ModalLaunchAllocation, "size"> & { source: { kind: "snapshot" } };
  initialPrompt?: string;
  armadaAccess?: SandboxArmadaAccessOptions;
  connections?: string[];
  resolvedSkills?: string[];
  deadline: Date;
  maxAttempts: number;
}

export const boatAuthority = z.object({
  scope: z.enum(["org", "user"]),
  backendId: z.string().min(1),
});
export type BoatAuthority = z.infer<typeof boatAuthority>;

type ArchivedLaunchReceipt =
  | { receipt: "accepted" | "unknown" }
  | { receipt: "refused"; failure: OrdinaryLaunchFailure };

type LaunchReceiptRow = {
  sandbox_id: string;
  status: SandboxStatus | null;
  golden_id: string | null;
  outcome: ArchivedLaunchReceipt | null;
};

function ordinaryModalKey(key: string) {
  return JSON.stringify(["ordinary", Buffer.from(key, "utf8").toString("utf8")]);
}

function replayLaunchReceipt(receipt: LaunchReceiptRow, goldenId: string) {
  if (receipt.golden_id && receipt.golden_id !== goldenId)
    throw new GoldenError("conflict", "Launch key conflicts with an existing receipt.");
  if (receipt.outcome?.receipt === "refused") throw replayOrdinaryLaunchFailure(receipt.outcome.failure);
  if (receipt.outcome?.receipt === "unknown")
    throw new LaunchError(
      "outcome_unknown",
      `Launch outcome unknown; receipt ${receipt.sandbox_id}. Do not use a new key.`,
    );
  return { sandbox: { id: receipt.sandbox_id, status: receipt.status ?? "deleted" } } satisfies ModalLaunchReceipt;
}

export async function replayModalLaunch(
  sql: Sql,
  actor: GoldenActor,
  goldenId: string,
  request: NonNullable<ModalLaunchAdmission["request"]>,
  provider = "modal",
) {
  const { orgId, userId } = actor;
  const {
    rows: [receipt],
  } = await sql.query<LaunchReceiptRow & { request_digest: string }>(
    `select j.sandbox_id,${publicSandboxStatusSql} as status,s.golden_id,j.outcome,j.request_digest
     from public.jobs j
     join public.members m on m.org_id=j.org_id and m.user_id=j.request_owner_id
     join public.goldens g on g.id=$4 and g.org_id=j.org_id and g.provider::text=$5 and g.removed_at is null
       and (g.visibility='org' or g.owner_id=j.request_owner_id)
     left join public.sandboxes s on s.id=j.sandbox_id and s.org_id=j.org_id and s.owner_id=j.request_owner_id
     where j.idem_key=$1 and j.kind='launch' and j.org_id=$2 and j.request_owner_id=$3`,
    [jobRequestKey(orgId, "launch", userId, ordinaryModalKey(request.key)), orgId, userId, goldenId, provider],
  );
  if (!receipt) return;
  if (receipt.request_digest !== ordinaryLaunchFingerprint(request.payload))
    throw new GoldenError("conflict", "Launch key conflicts with an existing receipt.");
  return replayLaunchReceipt(receipt, goldenId);
}

export const MODAL_INITIAL_TURN = "launch_initial_turn";

async function lockPinnedModalReservation(sql: Sql, orgId: string, ownerId: string, receiptId: string) {
  const {
    rows: [reservation],
  } = await sql.query<{
    id: string;
    sandbox_id: string;
    digest: string;
    available: boolean;
    template_scope: string;
    frozen_golden: Pick<
      GoldenRecord,
      "id" | "provider" | "providerSandboxId" | "providerSnapshotId" | "modal" | "config"
    > | null;
    frozen_connections: unknown;
    frozen_skills: unknown;
  }>(
    `select r.id,r.sandbox_id,r.digest,t.scope as template_scope,r.manifest->'golden' as frozen_golden,
            r.manifest->'connections' as frozen_connections,r.manifest->'resolvedSkills' as frozen_skills,
            r.state='claimed' and r.result is null
              and not exists(select 1 from public.sandboxes s where s.id=r.sandbox_id) as available
     from public.template_launch_requests r
     join public.launch_templates t on t.id=r.template_id and t.org_id=r.org_id
     join public.members m on m.org_id=r.org_id and m.user_id=r.actor_id
     where r.id=$1 and r.org_id=$2 and r.actor_id=$3
     for update of r,t for share of m`,
    [receiptId, orgId, ownerId],
  );
  if (!reservation) throw new GoldenError("not_found", "Modal template launch reservation not found.");
  return reservation;
}

export async function admitModalLaunch(
  sql: Sql,
  encryptionKey: string,
  input: ModalLaunchAdmission,
  { bindLaunch }: Pick<RuntimeMcp, "bindLaunch">,
) {
  if (!sql.transaction) throw new Error("Modal admission requires a transaction.");
  const {
    orgId,
    ownerId,
    sandbox: plannedSandbox,
    allocation,
    request,
    templateReceiptId,
    armadaAccess,
    child,
  } = input;
  const provider = input.boat ? "boat" : "modal";
  if (Number(Boolean(request)) + Number(Boolean(templateReceiptId)) + Number(Boolean(child)) > 1)
    throw new Error("Modal launch admission requires one receipt identity.");
  if (child && (armadaAccess || input.accountPool || child.orgId !== orgId || child.ownerId !== ownerId))
    throw new Error("Invalid child launch admission.");
  const fingerprint = request && ordinaryLaunchFingerprint(request.payload);
  const generation = 1;
  const store = createJobsStore(sql, encryptionKey);

  let admissionCallbackCompleted = false;
  let childAdmissionPhase = "launch_admission";
  try {
    const receipt: ModalLaunchReceipt = await sql.transaction(async (tx) => {
      if (child) {
        await tx.query(childLaunchLockBudget);
        const { rows } = await tx.query("select 1 from public.members where org_id=$1 and user_id=$2 for share", [
          orgId,
          ownerId,
        ]);
        if (!rows.length) throw new ChildLaunchNotAllocated("preallocation_rejected", "parent_authority");
      }
      const reservation = templateReceiptId
        ? await lockPinnedModalReservation(tx, orgId, ownerId, templateReceiptId)
        : undefined;
      const sandboxId = child?.sandboxId ?? reservation?.sandbox_id ?? crypto.randomUUID();
      const key = child
        ? JSON.stringify(["child", child.id])
        : reservation
          ? JSON.stringify(["template", reservation.id])
          : request
            ? ordinaryModalKey(request.key)
            : JSON.stringify(["unkeyed", sandboxId]);
      if (reservation) {
        const {
          rows: [existing],
        } = await tx.query<{
          sandbox_id: string;
          request_digest: string;
          status: SandboxStatus | null;
        }>(
          `select j.sandbox_id,j.request_digest,${publicSandboxStatusSql} as status
           from public.jobs j left join public.sandboxes s
             on s.id=j.sandbox_id and s.org_id=j.org_id and s.owner_id=j.request_owner_id
           where j.idem_key=$1 and j.kind='launch' and j.org_id=$2 and j.request_owner_id=$3`,
          [jobRequestKey(orgId, "launch", ownerId, key), orgId, ownerId],
        );
        if (existing) {
          if (existing.sandbox_id !== sandboxId || existing.request_digest !== reservation.digest)
            throw new GoldenError("conflict", "Modal template launch reservation conflicts with an existing job.");
          return { sandbox: { id: sandboxId, status: existing.status ?? "deleted" } };
        }
        if (!reservation.available)
          throw new GoldenError("conflict", "Modal template launch reservation is no longer available.");
      }
      const {
        rows: [golden],
      } = await tx.query<{
        visibility: "org" | "private";
        config: unknown;
        provider_snapshot_id: string | null;
        provider_sandbox_id: string;
        modal: { workspace: string; environment: string; appId: string };
      }>(
        `with golden as materialized (
           select g.visibility,g.config,g.provider_snapshot_id,g.provider_sandbox_id,
                  jsonb_build_object('workspace',g.modal_workspace,'environment',g.modal_environment,'appId',g.modal_app_id) as modal
           from public.goldens g join public.members m on m.org_id=g.org_id and m.user_id=$3
           where g.id=$1 and g.org_id=$2 and g.provider::text=$4 and g.removed_at is null
             and (g.visibility='org' or g.owner_id=$3)
           for update of g for share of m
         )
         select golden.*, case when provider_snapshot_id=$5 then public.lock_golden_snapshot($4,$5) end
         from golden`,
        [plannedSandbox.goldenId, orgId, ownerId, provider, allocation.source.ref],
      );
      if (!golden) throw new GoldenError("not_found", "Modal golden not found.");

      const snapshot = allocation.source.ref;
      const { modal } = golden;
      if (reservation) {
        const frozen = reservation.frozen_golden;
        if (
          frozen?.id !== plannedSandbox.goldenId ||
          frozen.provider !== provider ||
          frozen.providerSnapshotId !== snapshot ||
          (input.boat
            ? frozen.providerSandboxId !== golden.provider_sandbox_id
            : frozen.modal?.workspace !== modal.workspace ||
              frozen.modal?.environment !== modal.environment ||
              frozen.modal?.appId !== modal.appId)
        ) {
          throw new GoldenError("conflict", "Frozen template snapshot or provider binding changed.");
        }
      }
      // WARNING: Read the retirement seal with a fresh snapshot after acquiring the advisory lock.
      const {
        rows: [snapshotState],
      } = await tx.query<{ image_id: string | null; sealed: boolean }>(
        `select (select record->>'imageId' from public.modal_images
                   where scope=$3 and name=$1 and record #>> '{info,status}'='ready'
                     and record->>'deleted' is distinct from 'true' and nullif(record->>'imageId','') is not null
                ) as image_id,
                exists(select 1 from public.golden_snapshot_retirements
                       where provider::text=$2 and old_snapshot=$1 and sealed) as sealed`,
        [
          snapshot,
          provider,
          input.boat ? null : scopeKey({ orgId, userId: ownerId, visibility: golden.visibility, binding: modal }),
        ],
      );
      const imageId = input.boat ? snapshot : snapshotState?.image_id;
      const { credentialId: plannedAccount, credentialVersion: plannedVersion } = plannedSandbox;
      // WARNING: Parent turn workers lock the account before the parent sandbox.
      if (child && plannedAccount != null && plannedVersion != null)
        await lockAndCheckStartingLaunchAccount(
          tx,
          { credentialId: plannedAccount, credentialVersion: plannedVersion },
          sandboxId,
          plannedSandbox.model,
        );
      childAdmissionPhase = "parent_authority_lock";
      const childDigest = child && (await lockChildLaunchAdmission(tx, child));
      childAdmissionPhase = "launch_admission";
      const digest = childDigest ?? reservation?.digest ?? fingerprint ?? sandboxId;
      const { id: jobId, inserted } = await enqueueLaunch(
        store,
        sandboxId,
        generation,
        key,
        {
          allocation: {
            ...allocation,
            size: plannedSandbox.machineSize.effective,
            source: { kind: "snapshot", ref: imageId ?? undefined },
          },
          snapshot,
          ...(child ? { childOperationId: child.id } : {}),
          ...(reservation ? { templateReceiptId: reservation.id } : {}),
          ...(input.boat ? { boat: input.boat } : { modal }),
        },
        {
          orgId,
          deadline: input.deadline,
          maxAttempts: input.maxAttempts,
          request: { ownerId, digest },
        },
        tx,
      );
      if (!inserted) {
        const {
          rows: [receipt],
        } = await tx.query<LaunchReceiptRow>(
          `select j.sandbox_id, ${publicSandboxStatusSql} as status, s.golden_id, j.outcome from public.jobs j
         left join public.sandboxes s on s.id=j.sandbox_id and s.org_id=j.org_id and s.owner_id=j.request_owner_id
         where j.id=$1 and j.kind='launch' and j.org_id=$2 and j.request_owner_id=$3`,
          [jobId, orgId, ownerId],
        );
        if (!receipt) throw new Error("Modal launch receipt is missing.");
        if (receipt.sandbox_id !== sandboxId) return replayLaunchReceipt(receipt, plannedSandbox.goldenId);
      }

      if (golden.provider_snapshot_id !== snapshot)
        throw new GoldenError("conflict", "Golden snapshot changed during launch preparation.");
      if (snapshotState?.sealed) throw new GoldenError("conflict", "Golden snapshot is being retired.");
      if (!imageId) throw new GoldenError("conflict", "Modal golden snapshot image is unavailable.");

      let sandbox = plannedSandbox;
      let accountSkips: AccountSkip[] = [];
      if (input.accountPool) {
        const { pool, prepared } = input.accountPool;
        const { credentialId, candidate, skips } = await admitAccount(tx, ownerId, pool, sandboxId, prepared);
        sandbox = { ...sandbox, ...candidate, credentialId };
        accountSkips = skips;
      }
      const visibility = child || armadaAccess || sandbox.visibility === "private" ? "private" : golden.visibility;
      const scopedCredential = sandbox.credentialId;
      if (armadaAccess) {
        const limit = armadaAccess.maxActiveChildren;
        if (reservation || sandbox.harness !== "codex" || !scopedCredential || !sandbox.credentialVersion)
          throw new VaultError(
            "invalid",
            "Scoped Armada access requires an ordinary Modal launch with a bound Codex account.",
          );
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
          throw new VaultError("invalid", "Scoped Armada access requires a child limit between 1 and 100.");
      }
      const actor = { userId: ownerId, orgId };
      const { credentialId, credentialVersion } = sandbox;
      if (!child && !input.accountPool && credentialId != null && credentialVersion != null)
        await lockAndCheckStartingLaunchAccount(tx, { credentialId, credentialVersion }, sandboxId, sandbox.model);
      await input.revalidateTemplate?.(tx);
      await insertStartingModalSandbox(
        tx,
        {
          sandboxId,
          orgId,
          ownerId,
          generation,
          snapshot,
          provider,
          visibility,
        },
        sandbox,
      );
      if (child) await completeChildLaunchAdmission(tx, child);
      if (armadaAccess && scopedCredential)
        await registerSandboxArmadaParent(tx, actor, sandboxId, sandbox.goldenId, scopedCredential, armadaAccess);
      if (reservation) {
        const { bindings } = await readRuntimeTemplateEnvironment(tx, actor, sandboxId, provider);
        await assertLaunchSecretBindings(tx, actor, bindings, reservation.template_scope === "org");
        if (bindings.length) await taintStartingModalSandbox(tx, sandboxId, generation);
        const pins = pinnedMcpConnections.safeParse(reservation.frozen_connections);
        if (!pins.success) throw new GoldenError("conflict", "Frozen Modal template MCP connections are invalid.");
        await bindLaunch(tx, actor, sandboxId, visibility, {
          pins: pins.data,
          orgTemplate: reservation.template_scope === "org",
        });
      } else {
        await bindLaunch(tx, actor, sandboxId, visibility, { requested: input.connections });
      }
      const skills = reservation ? reservation.frozen_skills : (input.resolvedSkills ?? []);
      try {
        validateSkillPins(skills);
      } catch {
        throw new GoldenError(reservation ? "conflict" : "invalid_config", "Modal launch skill pins are invalid.");
      }
      const workspace = parseGoldenConfig(reservation ? reservation.frozen_golden?.config : golden.config);
      await store.enqueue(
        MODAL_INITIAL_TURN,
        sandboxId,
        generation,
        sandboxId,
        {
          launchJobId: jobId,
          ...(child ? { childOperationId: child.id } : {}),
          ...(reservation ? { templateReceiptId: reservation.id } : {}),
          ...(accountSkips.length ? { accountSkips } : {}),
          prompt: input.initialPrompt,
          workspace,
          skills,
          ...(armadaAccess ? { scopedAccess: true } : {}),
        },
        { orgId, maxAttempts: 3, runAfter: input.deadline },
        tx,
      );
      const envelope = { sandbox: { id: sandboxId, status: "starting" as const } };
      if (reservation) {
        const result = {
          requestId: reservation.id,
          state: "succeeded",
          id: sandboxId,
          provider,
          ...(sandbox.externalRef === undefined ? {} : { externalRef: sandbox.externalRef }),
          status: envelope.sandbox.status,
          envelope,
        };
        await tx.query(
          `update public.template_launch_requests
           set state='succeeded', result=$2::jsonb || jsonb_build_object('manifest',manifest), updated_at=now()
           where id=$1`,
          [reservation.id, JSON.stringify(result)],
        );
      }
      admissionCallbackCompleted = true;
      return envelope;
    });
    if (admissionCallbackCompleted) {
      recordModalLaunchAdmission(receipt.sandbox.id);
      if (input.boat) Object.defineProperty(receipt, freshBoatAdmission, { value: true });
    }
    return receipt;
  } catch (error) {
    const databaseError = error as { errno?: string; code?: string } | null;
    if (child && !admissionCallbackCompleted && (databaseError?.errno ?? databaseError?.code) === "55P03")
      throw new ChildLaunchNotAllocated("admission_lock_contended", childAdmissionPhase, error);
    if (error instanceof ConflictingJobRequest)
      throw new GoldenError("conflict", "Launch key conflicts with an existing receipt.");
    throw error;
  }
}

export function createModalInitialTurnJob(
  sql: Sql,
  encryptionKey: string,
  queue: Pick<AccountTurnQueue, "acceptInitialLaunch">,
  environment: Pick<ReturnType<typeof createGoldenRuntimeEnvironment>, "deliver">,
  commands: Parameters<typeof runtimeAgentFor>[0],
  prepareMcp: RuntimeMcp["prepare"],
  github?: Pick<RuntimeGitHub, "prepareLaunch">,
  restoreScopedAccess?: RestoreScopedRuntimeAccess,
) {
  const runtime = createRuntimeEnrolments(sql, encryptionKey);
  return {
    concurrency: 4,
    async run(job, context) {
      const sandboxId = job.sandbox_id;
      const generation = job.generation;
      const payload = z
        .object({
          launchJobId: z.string().uuid(),
          childOperationId: z.string().uuid().optional(),
          templateReceiptId: z.string().uuid().optional(),
          prompt: z.string().optional(),
          workspace: z.unknown(),
          skills: z.array(z.string()),
          scopedAccess: z.literal(true).optional(),
        })
        .safeParse(job.payload);
      if (!sandboxId || !generation || !payload.success)
        return { status: "fail", reason: "invalid_modal_initial_turn" };

      const timePhase = modalLaunchSetupTimer({ sandboxId, jobId: job.id, generation, attempt: job.attempts });

      const endLoad = timePhase("load_target");
      const {
        rows: [target],
      } = await sql
        .query<{
          org_id: string;
          owner_id: string;
          provider: "boat" | "modal";
          role: MemberRole;
          provider_sandbox_id: string;
          repository_dir: string | null;
          harness: Harness;
          state: string;
          epoch: string | null;
          accepted: boolean;
        }>(
          `select s.org_id, s.owner_id, s.provider, m.role, s.provider_sandbox_id, s.repository_dir, s.harness, launch.state, runtime.epoch::text as epoch,
                exists(select 1 from public.account_turn_queue q
                       where q.sandbox_id=s.id and q.request_id=intent.id
                         and q.queued_generation=intent.generation and q.owner_id=s.owner_id and q.org_id=s.org_id
                ) as accepted
         from public.jobs intent
         join public.sandboxes s on s.id=intent.sandbox_id and s.lifecycle_generation=intent.generation
           and s.org_id=intent.org_id and (s.runtime_transport='dialout' or s.boat_runtime)
         join public.jobs launch on launch.sandbox_id=s.id and launch.generation=intent.generation
           and launch.org_id=s.org_id and launch.request_owner_id=s.owner_id and launch.kind='launch'
           and launch.id=$2
         join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
         left join public.runtime_enrolments runtime on runtime.sandbox_id=s.id
           and runtime.lifecycle_generation=s.lifecycle_generation and runtime.runtime_hash is not null
           and s.status in ('ready','running') and s.stop_requested_at is null and s.deleted_at is null
         where intent.id=$1`,
          [job.id, payload.data.launchJobId],
        )
        .finally(endLoad);
      if (target?.accepted) return { status: "done" };
      if (!target || target.state === "failed") return { status: "fail", reason: "modal_initial_turn_unavailable" };
      if (!(await context.canDispatch())) return { status: "fail", reason: "modal_initial_turn_budget_exhausted" };
      if (target.state !== "done") return { status: "retry", after: new Date(Date.now() + 10_000), unattempted: true };

      const { epoch } = target;
      const actor = { userId: target.owner_id, orgId: target.org_id, role: target.role };
      const canDispatch = async (tx: Sql) =>
        (await context.canDispatch(tx)) && launchAuthorityCurrent(tx, sandboxId, payload.data);
      const assertClaim = async (tx: Sql) => {
        if (!(await canDispatch(tx))) throw new VaultError("conflict", "Launch setup authority is unavailable.");
      };
      if (epoch === null) return { status: "fail", reason: "modal_initial_turn_unavailable" };
      const assertRuntimeClaim = async (tx: Sql) => {
        await assertClaim(tx);
        const { rows } = await tx.query(
          `select 1 from public.runtime_enrolments
           where sandbox_id=$1 and lifecycle_generation=$2 and epoch=$3 and runtime_hash is not null`,
          [sandboxId, generation, epoch],
        );
        if (!rows.length) throw new GoldenError("conflict", "Modal setup runtime changed.");
      };
      const endEnvironment = timePhase("environment");
      try {
        await environment.deliver(target.provider, actor, sandboxId, epoch, context.signal, async (tx) => {
          await assertClaim(tx);
          const { rows } = await tx.query(
            "select 1 from public.sandboxes where id=$1 and lifecycle_generation=$2 and application_secret_tainted",
            [sandboxId, generation],
          );
          if (!rows.length) throw new VaultError("conflict", "Application-secret restrictions are missing.");
        });
      } catch (error) {
        if (error instanceof RuntimeCommandRefused || (error instanceof VaultError && error.code === "conflict"))
          return { status: "fail", reason: "modal_initial_turn_environment_refused" };
        recordOperatorFailure("modal.launch_setup.environment", error, { sandboxId });
        throw error;
      } finally {
        endEnvironment();
      }

      const { skills } = payload.data;
      const needsSkillpackKey = skills.some((reference) => !reference.includes("/"));
      const resolveSkillpackKey = async (tx: Sql) => {
        const reader = {
          ...createSqlVaultStore(tx),
          async credentials(scope: "user" | "org", ownerId: string) {
            const { rows } = await tx.query<{
              status: string;
              expiresAt: string | null;
              valueEnc: Uint8Array<ArrayBuffer>;
            }>(
              `select status,expires_at as "expiresAt",value_enc as "valueEnc"
               from public.credentials where scope=$1 and owner_id=$2 and kind='skillpack' for share`,
              [scope, ownerId],
            );
            return rows.map((row) => ({ ...row, kind: "skillpack" as const }));
          },
        };
        const key = await launchCredentials(reader, encryptionKey).skillpackKey?.(actor);
        if (!key) throw new PrivateSkillError("skillpack_credential_missing", "credential");
        return key;
      };
      const agent = runtimeAgentFor(
        {
          call: (owner, command, options) =>
            commands.call(owner, command, {
              ...options,
              assertClaim,
              ...(needsSkillpackKey && command.op === "installSkills" ? { resolveSkillpackKey } : {}),
            }),
        },
        actor.userId,
        {
          id: sandboxId,
          provider: target.provider,
          harness: target.harness,
          repositoryDir: target.repository_dir,
          providerSandboxId: target.provider_sandbox_id,
        },
        { model: "", reasoningEffort: "" },
      );
      const endWorkspace = timePhase("workspace");
      try {
        const config = parseModalLaunchWorkspace(payload.data);
        let workspaceStarted = false;
        if (github) {
          const endLookup = timePhase("workspace", { step: "receipt_lookup" });
          try {
            const { rows } = await sql.query(
              "select 1 from public.runtime_commands where sandbox_id=$1 and epoch=$2 and request_id=$3",
              [sandboxId, epoch, workspaceCommandId(epoch, { phase: "repository", index: 0, attempt: 0 })],
            );
            workspaceStarted = rows.length > 0;
          } finally {
            endLookup();
          }
        }
        const workspace = runtimeWorkspace(
          {
            actor,
            host: { id: target.provider },
            sandbox: { id: sandboxId, providerSandboxId: target.provider_sandbox_id },
            credentials: { secrets: [] },
            signal: context.signal,
          },
          agent,
          epoch,
          workspaceStarted ? undefined : github,
          {
            trackPushes: true,
            healthRequestId: `workspace_health_${job.id}_${epoch}`,
            timeStep: (step) => timePhase("workspace", step),
            assertClaim: assertRuntimeClaim,
          },
        );
        await workspace.prepareWorkspace({ config }, () => {});
      } catch (error) {
        if (
          error instanceof LaunchError ||
          error instanceof GoldenError ||
          (error instanceof ProviderError && !error.details?.runtimeRequestId)
        )
          return { status: "fail", reason: "modal_initial_turn_workspace_refused" };
        recordOperatorDiagnostic("modal.launch_setup.workspace", failureDiagnostic(error), {
          sandboxId,
          code:
            error instanceof RuntimeGitHubDeliveryError
              ? "github_configuration_unacknowledged"
              : "modal_initial_turn_workspace_error",
          ...(error instanceof ProviderError ? { causeCode: error.code } : {}),
        });
        throw error;
      } finally {
        endWorkspace();
      }

      if (skills.length) {
        const endPhase = timePhase("skills");
        try {
          const receipts = await agent.installSkills(skills, null, epoch, context.signal, `skills_${job.id}_${epoch}`);
          await runtime.withOwner(
            sandboxId,
            actor.userId,
            async (tx, scope) => {
              if (scope.epoch !== epoch) throw new GoldenError("conflict", "Modal setup runtime changed.");
              await assertClaim(tx);
              await createSqlSandboxStore(scopedRuntimeSql(tx)).recordSkills!(sandboxId, receipts);
            },
            generation,
          );
        } catch (error) {
          if (
            error instanceof PrivateSkillError ||
            (error instanceof ProviderError && !error.details?.runtimeRequestId)
          )
            return { status: "fail", reason: "modal_initial_turn_skills_refused" };
          recordOperatorFailure("modal.launch_setup.skills", error, { sandboxId });
          throw error;
        } finally {
          endPhase();
        }
      }

      const caller: Caller = {
        userId: target.owner_id,
        orgs: [{ orgId: target.org_id, role: target.role }],
        via: "service",
      };
      const endMcp = timePhase("mcp");
      try {
        await prepareMcp(caller, sandboxId, context.signal, assertRuntimeClaim, `mcp_health_${job.id}_${epoch}`);
      } catch (error) {
        if (error instanceof VaultError || error instanceof RuntimeCommandRefused || error instanceof GoldenError)
          return { status: "fail", reason: "modal_initial_turn_mcp_refused" };
        recordOperatorFailure("modal.launch_setup.mcp", error, { sandboxId });
        throw error;
      } finally {
        endMcp();
      }

      if (payload.data.scopedAccess) {
        if (!restoreScopedAccess) return { status: "fail", reason: "modal_initial_turn_scoped_access_unavailable" };
        const projectDir = target.repository_dir ? `${GOLDEN_ROOT}/${target.repository_dir}` : GOLDEN_ROOT;
        const endPhase = timePhase("scoped_access");
        try {
          const installed = await agent.workspaceExec(
            {
              sandboxId: target.provider_sandbox_id,
              cwd: projectDir,
              command: sandboxAccessReferenceCommand(projectDir, target.harness),
              timeoutSeconds: 300,
            },
            SCOPED_REFERENCE_STEP,
            epoch,
            context.signal,
          );
          if (installed.detached || installed.timedOut || installed.truncated || installed.exitCode !== 0)
            return { status: "fail", reason: "modal_initial_turn_scoped_reference_refused" };
          await restoreScopedAccess(
            actor.userId,
            sandboxId,
            epoch,
            String(generation),
            context.signal,
            assertRuntimeClaim,
            true,
          );
        } catch (error) {
          recordOperatorFailure("modal.launch_setup.scoped_access", error, { sandboxId });
          throw error;
        } finally {
          endPhase();
        }
      }

      const { prompt } = payload.data;
      if (prompt === undefined) return { status: "done" };

      const endFirstPrompt = timePhase("first_prompt");
      try {
        const accepted = await queue.acceptInitialLaunch(
          caller,
          { id: sandboxId, request_id: job.id, prompt },
          generation,
          async (tx) => {
            if (!tx) return false;
            const { rows } = await tx.query(
              `select 1 from public.runtime_enrolments
               where sandbox_id=$1 and lifecycle_generation=$2 and epoch=$3 and runtime_hash is not null`,
              [sandboxId, generation, epoch],
            );
            return rows.length > 0 && canDispatch(tx);
          },
          { childOperationId: payload.data.childOperationId, templateReceiptId: payload.data.templateReceiptId },
        );
        if (accepted) return { status: "done" };
      } catch (error) {
        if (!(error instanceof VaultError) || !["conflict", "not_found", "invalid"].includes(error.code)) {
          recordOperatorFailure("modal.launch_setup.first_prompt", error, { sandboxId });
          throw error;
        }
      } finally {
        endFirstPrompt();
      }
      return { status: "fail", reason: "modal_initial_turn_refused" };
    },
  } satisfies JobKind;
}

type DispatchContext = Pick<JobContext, "canDispatch" | "signal">;

type ModalMachineRuntime = Omit<ModalMachineOptions, "journal">;
type PrepareModalTicket = ModalMachineRuntime["resolveRuntimeTicket"];
type ModalTicket = NonNullable<Awaited<ReturnType<PrepareModalTicket>>>;
type IssueRuntimeTicket = Parameters<ReturnType<typeof createRuntimeEnrolments>["issue"]>[0];

interface ModalPlacementPlan {
  placement: ModalLaunchPlacement;
  computeExpiresAt: Date;
  allocation: ModalLaunchAllocation;
  bindingRef: string;
  machine: Omit<ModalMachineRuntime, "resolveRuntimeTicket">;
  modalCredential(): Promise<{ id: string; version: number }>;
}
type BoatLaunchPlan = {
  boat: string;
  allocation: ModalLaunchAllocation;
  bindingRef: string;
  machine(
    ticket: (request: MachineIdentity, expiresAt: number) => Promise<ModalTicket | null>,
    authorize: () => Promise<void>,
  ): Machine;
  canUseModalCredential(tx: Sql): Promise<boolean>;
};
type ModalLaunchPlan = (ModalPlacementPlan | BoatLaunchPlan) & {
  prepareRuntimeTicket(request: Parameters<PrepareModalTicket>[0]): Promise<
    Omit<ModalTicket, "enrolmentToken"> &
      Pick<IssueRuntimeTicket, "ownerId"> & {
        configuration: IssueRuntimeTicket["configuration"] & { grant: { expiresAt: number } };
      } & Pick<RuntimeTicketGuard, "lockPrerequisites"> & {
        accountPin: Pick<RuntimeConfigurationTarget, "credentialId" | "credentialVersion">;
      }
  >;
};

type OpenModalMachine = (
  app: { binding: ModalBinding; appName: string; credentialScope: "org" | "user"; credentialOwnerId: string },
  signal: AbortSignal,
) => Promise<ModalMachineRuntime & { close(): void }>;

class ModalBootstrapRefused extends Error {}

export function modalLaunchTicketGuard(sandbox: RuntimeConfigurationTarget) {
  return {
    async lockPrerequisites(tx: Sql) {
      const {
        rows: [authority],
      } = await tx.query<{ member: boolean; credential: boolean }>(
        `with member as materialized (
           select user_id from public.members where org_id=$1 and user_id=$2 for update
         ), credential as materialized (
           select version, kind, status, expires_at, scope, owner_id
           from public.credentials where id=$3 and (select user_id from member) is not null for share
         )
         select exists(select 1 from member) as member,
           exists(select 1 from credential where version=$4 and kind=any($5::public.credential_kind[])
             and status='active' and (expires_at is null or expires_at>clock_timestamp())
             and ((scope='user' and owner_id=$2) or (scope='org' and owner_id=$1))) as credential`,
        [
          sandbox.orgId,
          sandbox.ownerId,
          sandbox.credentialId,
          sandbox.credentialVersion,
          HARNESS_KINDS[sandbox.harness],
        ],
      );
      if (!authority?.member) throw new ModalBootstrapRefused("Modal launch owner membership is unavailable.");
      if (!authority.credential) throw new ModalBootstrapRefused("Modal launch account is unavailable.");
    },
    accountPin: {
      credentialId: sandbox.credentialId ?? null,
      credentialVersion: sandbox.credentialVersion ?? null,
    },
  };
}

const launchAllocation = z.object({
  allocation: z.object({
    source: z.object({ kind: z.literal("snapshot"), ref: z.string().min(1) }),
    size: z.enum(MACHINE_SIZES).nullable(),
    computeTtlSeconds: z.number().int().positive(),
  }),
  snapshot: z.string().min(1),
  childOperationId: z.string().uuid().optional(),
  templateReceiptId: z.string().uuid().optional(),
});
export const boatLaunchPayload = launchAllocation.extend({ boat: boatAuthority });
function boatAuthorityPayload(payload: unknown) {
  return typeof payload === "object" && payload !== null && "boat" in payload
    ? { boat: boatLaunchPayload.parse(payload).boat }
    : {};
}
const launchPayload = launchAllocation.extend({
  modal: z.object({ workspace: z.string().min(1), environment: z.string().min(1), appId: z.string().min(1) }),
});

export function createModalLaunchJob(
  sql: Sql,
  encryptionKey: string,
  openMachine: (
    ...args: Parameters<OpenModalMachine>
  ) => Promise<Awaited<ReturnType<OpenModalMachine>> & Pick<ModalPlacementPlan, "modalCredential">>,
  prepareRuntimeTicket: (sandbox: RuntimeConfigurationTarget) => ReturnType<ModalLaunchPlan["prepareRuntimeTicket"]>,
) {
  return {
    concurrency: 4,
    async run(job, context) {
      let machine: Awaited<ReturnType<typeof openMachine>> | undefined;
      try {
        return await runModalLaunch(sql, encryptionKey, job, context, async () => {
          const payload = launchPayload.safeParse(job.payload);
          if (!payload.success) throw new Error("Invalid Modal launch payload.");
          const { allocation, snapshot, modal: binding } = payload.data;
          const target = await withJobLease(sql, job, async (tx) => {
            const {
              rows: [row],
            } = await tx.query<
              RuntimeConfigurationTarget & {
                jobCreatedAt: Date;
                appName: string;
                sourceVisibility: ModalLaunchPlacement["sourceVisibility"];
                visibility: ModalLaunchPlacement["scope"]["visibility"];
                credentialScope: "org" | "user";
                credentialOwnerId: string;
              }
            >(
              `select s.id, s.org_id as "orgId", s.owner_id as "ownerId", s.provider, s.harness, s.status,
                      s.deleted_at as "deletedAt", s.stop_requested_at as "stopRequestedAt",
                      s.expires_at as "expiresAt", s.credential_id as "credentialId",
                      s.credential_version as "credentialVersion", s.repository_dir as "repositoryDir",
                      j.created_at as "jobCreatedAt", s.visibility, s.source_golden_visibility as "sourceVisibility", a.app_name as "appName", a.authority_scope as "credentialScope",
                      a.authority_owner_id as "credentialOwnerId"
               from public.sandboxes s
               join public.jobs j on j.id=$2 and j.sandbox_id=s.id and j.generation=s.lifecycle_generation
                 and j.org_id=s.org_id and j.request_owner_id=s.owner_id
               join public.sandbox_source_snapshots snap on snap.sandbox_id=s.id and snap.snapshot_id=$3
               join public.modal_server_apps a on a.org_id=s.org_id and a.environment=$4 and a.app_id=$5
               join public.goldens g on g.id=s.golden_id and g.org_id=s.org_id
                 and g.modal_workspace=$6 and g.modal_environment=a.environment and g.modal_app_id=a.app_id
               where s.id=$1 and s.provider='modal' and s.runtime_transport='dialout'
                 and ((a.authority_scope='org' and a.authority_owner_id=s.org_id)
                   or (a.authority_scope='user' and a.authority_owner_id=s.owner_id))`,
              [job.sandbox_id, job.id, snapshot, binding.environment, binding.appId, binding.workspace],
            );
            if (!row) throw new Error("Modal launch App or snapshot authority is unavailable.");
            return row;
          });
          if (!target) return;
          context.signal.throwIfAborted();
          const { appName, credentialScope, credentialOwnerId, sourceVisibility, jobCreatedAt, ...sandbox } = target;
          const computeExpiresAt = new Date(new Date(jobCreatedAt).getTime() + allocation.computeTtlSeconds * 1000);
          machine = await openMachine({ binding, appName, credentialScope, credentialOwnerId }, context.signal);
          return {
            allocation,
            computeExpiresAt,
            placement: {
              scope: { orgId: sandbox.orgId, userId: sandbox.ownerId, visibility: sandbox.visibility, binding },
              sourceVisibility,
              snapshot,
              imageId: allocation.source.ref,
              managementAuthority: { credentialScope, credentialOwnerId },
            },
            bindingRef: job.id,
            machine,
            modalCredential: machine.modalCredential,
            prepareRuntimeTicket: () => prepareRuntimeTicket(sandbox),
          };
        });
      } finally {
        machine?.close();
      }
    },
  } satisfies JobKind;
}

const RECONCILING_ALLOCATION = "modal_launch_reconciling";
const RECONCILE_DELAY_MS = 30_000;
const ENROLMENT_RETRY_DELAY_MS = 1_000;
const DELETE_DISPATCH_BUDGET_MS = 5 * 60_000;

function hasModalMachineJournal(job: Job) {
  return typeof job.outcome === "object" && job.outcome !== null && "modal_machine" in job.outcome;
}

async function beforeProviderMutation<T>(context: DispatchContext, canDefer: boolean, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    context.signal.throwIfAborted();
    if (
      canDefer &&
      !(
        error instanceof ModalBootstrapRefused ||
        error instanceof RuntimeEnrolmentDenied ||
        error instanceof EncryptionKeyError ||
        error instanceof DOMException ||
        error instanceof SyntaxError
      ) &&
      (!(error instanceof ProviderError) || error.retryable) &&
      (await context.canDispatch())
    )
      return "deferred" as const;
    throw error;
  }
}

export async function runModalLaunch(
  sql: Sql,
  encryptionKey: string,
  job: Job,
  context: DispatchContext,
  preparePlan: () => ModalLaunchPlan | undefined | Promise<ModalLaunchPlan | undefined>,
  provider = "modal",
) {
  const sandboxId = job.sandbox_id;
  const generation = Number(job.generation);
  if (job.kind !== "launch" || !sandboxId || !Number.isSafeInteger(generation) || generation < 1)
    throw new Error("Invalid Modal launch claim.");

  const authority = launchAllocation.pick({ childOperationId: true, templateReceiptId: true }).parse(job.payload ?? {});
  const launchAuthorized = (tx: Sql) => launchAuthorityCurrent(tx, sandboxId, authority);

  const readEnrolment = async (tx: Sql) => {
    const {
      rows: [receipt],
    } = await tx.query<{
      org_id: string;
      credential_id: string | null;
      credential_version: number | null;
      provider_sandbox_id: string | null;
      journaled_id: string | null;
      has_intent: boolean;
      stop_requested: boolean;
      starting: boolean;
      enrolled: boolean;
      check_after: string | null;
      cancel_without_provider: boolean;
      bootstrap_ticket_enc: string | null;
      handoff_staged: boolean;
      ticket_issued: boolean;
    }>(
      `select s.org_id, s.provider_sandbox_id, s.credential_id, s.credential_version,
              j.outcome #>> '{modal_machine,entry,machineId}' as journaled_id,
              j.outcome #> '{modal_machine,entry}' is not null as has_intent,
              s.stop_requested_at is not null as stop_requested,
              s.status='starting' as starting,
              s.stop_requested_at is null and e.runtime_hash is not null as enrolled,
              s.stop_requested_at is not null and (
                j.outcome #> '{modal_machine,entry}' is null or s.provider_sandbox_id is not null
                or j.outcome #>> '{modal_machine,entry,machineId}' is not null
              ) as cancel_without_provider,
              case when s.stop_requested_at is null and e.enrolment_hash is not null
                     and e.enrolment_expires_at>clock_timestamp()
                     and j.deadline_at>clock_timestamp() and s.expires_at>clock_timestamp()
                then least(e.enrolment_expires_at,j.deadline_at,s.expires_at,clock_timestamp()+interval '10 seconds')::text
              end as check_after,
              j.outcome->>'bootstrap_ticket_enc' as bootstrap_ticket_enc,
              j.outcome->'modal_handoff' is not null as handoff_staged,
              e.enrolment_hash is not null as ticket_issued
       from public.sandboxes s
       join public.jobs j on j.id=$2 and j.sandbox_id=s.id and j.generation=s.lifecycle_generation
         and j.org_id=s.org_id and j.request_owner_id=s.owner_id
       left join public.runtime_enrolments e on e.sandbox_id=s.id and e.lifecycle_generation=s.lifecycle_generation
         and s.provider_sandbox_id is not null
       where s.id=$1 and s.provider::text=$3 and (s.runtime_transport='dialout' or s.boat_runtime)
         and s.status in ('starting','ready','running') and s.deleted_at is null`,
      [sandboxId, job.id, provider],
    );
    return receipt;
  };
  const readPinnedEnrolment = async (
    tx: Sql,
    pin: Pick<RuntimeConfigurationTarget, "credentialId" | "credentialVersion">,
  ) => {
    const receipt = await readEnrolment(tx);
    if (
      !receipt ||
      receipt.credential_id !== (pin.credentialId ?? null) ||
      receipt.credential_version !== (pin.credentialVersion ?? null)
    )
      throw new ModalBootstrapRefused("Modal launch account pin changed.");
    return receipt;
  };
  const done = {
    status: "done",
    commit: (tx) => wakeSandboxJobs(tx, sandboxId, [MODAL_INITIAL_TURN], generation),
  } satisfies JobResult;
  const retryUnattempted = (after = new Date(Date.now() + ENROLMENT_RETRY_DELAY_MS)) =>
    ({ status: "retry", after, unattempted: true }) satisfies JobResult;
  const hasJournal = hasModalMachineJournal(job);
  const initial = await beforeProviderMutation(context, hasJournal, async () => {
    const pending = await withJobLease(sql, job, readEnrolment);
    context.signal.throwIfAborted();
    if (!pending || pending.enrolled) return;
    const waitForEnrolment = pending.check_after && (!pending.bootstrap_ticket_enc || !(await context.canDispatch()));
    return { pending, waitForEnrolment };
  });
  if (initial === "deferred") return retryUnattempted();
  if (!initial) return done;
  const { pending, waitForEnrolment } = initial;
  if (waitForEnrolment && pending.check_after)
    return {
      ...retryUnattempted(new Date(pending.check_after)),
      commit: (tx) => wakeEnrolledSandboxJobs(tx, sandboxId, generation, ["launch"]),
    } satisfies JobResult;

  const startingTarget = async (tx: Sql) => {
    const row = await readEnrolment(tx);
    if (row?.starting) return row;
  };
  let skipProvider = pending.cancel_without_provider || (!hasJournal && !(await context.canDispatch()));
  let plan: ModalLaunchPlan | undefined;
  if (!skipProvider) {
    try {
      plan = await preparePlan();
    } catch (error) {
      context.signal.throwIfAborted();
      if (await context.canDispatch()) {
        if (!hasJournal) throw error;
        return retryUnattempted();
      }
      const target = await withJobLease(sql, job, startingTarget);
      if (!target) return done;
      if (target.has_intent && !target.provider_sandbox_id && !target.journaled_id) throw error;
      skipProvider = true;
    }
  }
  context.signal.throwIfAborted();
  if (!plan && !skipProvider) return done;

  const enrolmentInProgress = new Error("Modal launch enrolment already issued.");
  const enrolments = createRuntimeEnrolments(sql, encryptionKey);
  const targetIncarnation = {
    sandboxId,
    generation,
    awaitingEnrolment: Boolean(pending.check_after),
    handoffStaged: pending.handoff_staged,
    ticketIssued: pending.ticket_issued,
    replayingTicket: Boolean(pending.check_after && pending.bootstrap_ticket_enc),
  };
  const applyPlan = (plan: ModalLaunchPlan, resolve: Parameters<typeof dispatchModalLaunch>[5]) =>
    dispatchModalLaunch(sql, job, context, plan, targetIncarnation, resolve, launchAuthorized);
  const dispatch = plan
    ? await applyPlan(plan, async (request, preparation, handoff, physicalExpiry, lockExtra) => {
        const { ownerId, configuration, lockPrerequisites, accountPin, ...prepared } = preparation;
        if (pending.check_after && pending.bootstrap_ticket_enc) {
          const enrolmentToken = await decryptSecret(
            Uint8Array.from(Buffer.from(pending.bootstrap_ticket_enc, "base64")),
            encryptionKey,
          );
          const hash = await sha256Hex(enrolmentToken);
          if (!sql.transaction) throw new Error("Modal bootstrap replay requires a transaction.");
          const current = await sql.transaction(async (tx) => {
            await lockPrerequisites(tx);
            return withJobLease(scopedRuntimeSql(tx), job, async (locked) => {
              const receipt = await readPinnedEnrolment(locked, accountPin);
              if (!receipt.check_after || !(await context.canDispatch(locked)) || !(await launchAuthorized(locked)))
                return false;
              if (!("boat" in plan) && !receipt.handoff_staged)
                throw new ModalBootstrapRefused("Modal bootstrap replay lacks a prepared handoff.");
              const refreshed = await enrolments.refreshModalBootstrapManifest(
                locked,
                sandboxId,
                generation,
                hash,
                configuration.artifactManifest,
              );
              if (!(await context.canDispatch(locked)) || !(await launchAuthorized(locked)))
                throw new ModalBootstrapRefused("Modal bootstrap dispatch is no longer authorized.");
              return refreshed;
            });
          });
          return current ? { ...prepared, enrolmentToken } : null;
        }
        if (!("boat" in plan) && !handoff && !pending.handoff_staged) return null;
        const commandGrantExpiresAt = physicalExpiry ?? ("boat" in plan ? NaN : plan.computeExpiresAt.getTime());
        if (!Number.isFinite(commandGrantExpiresAt) || commandGrantExpiresAt < configuration.grant.expiresAt)
          throw new Error("Modal compute deadline does not cover the initial runtime grant.");
        try {
          const ticket = await enrolments.issue({
            sandboxId,
            ownerId,
            configuration: {
              ...configuration,
              grant: { ...configuration.grant, expiresAt: commandGrantExpiresAt },
            },
            commandGrantExpiresAt,
            expectedGeneration: generation,
            expectedProviderSandboxId: request.machineId,
            async assertClaim(tx) {
              if (!(await context.canDispatch(tx)) || !(await launchAuthorized(tx)))
                throw new ModalBootstrapRefused("Modal bootstrap dispatch is no longer authorized.");
            },
            async recordIssued(tx, enrolmentToken) {
              if (
                !(await recordModalBootstrapTicket(
                  tx,
                  job,
                  enrolmentToken,
                  encryptionKey,
                  request.machineId,
                  handoff,
                  "boat" in plan ? plan.boat : undefined,
                  "boat" in plan ? boatLaunchPayload.parse(job.payload).boat : undefined,
                ))
              )
                throw new ModalBootstrapRefused("Modal launch changed before handoff.");
            },
            ticketGuard: {
              async lockPrerequisites(tx) {
                await lockPrerequisites(tx);
                await lockExtra?.(tx);
              },
              async check(tx) {
                const receipt = await readPinnedEnrolment(tx, accountPin);
                if (receipt.enrolled || receipt.check_after) throw enrolmentInProgress;
              },
            },
          });
          return { ...prepared, enrolmentToken: ticket.enrolmentToken };
        } catch (error) {
          if (error === enrolmentInProgress) return null;
          throw error;
        }
      })
    : undefined;
  const settlement = await beforeProviderMutation(context, dispatch?.kind === "dispatch_deferred", async () => {
    const afterDispatch = await withJobLease(sql, job, readEnrolment);
    context.signal.throwIfAborted();
    if (afterDispatch?.starting && !afterDispatch.enrolled) return afterDispatch;
  });
  if (settlement === "deferred") return retryUnattempted();
  if (!settlement) return done;
  const target = settlement;
  if (dispatch?.kind === "dispatch_deferred" && !target.stop_requested) return retryUnattempted();
  if (dispatch?.kind === "bootstrapped" && !target.stop_requested) {
    return {
      status: "retry",
      after: target.check_after ? new Date(target.check_after) : new Date(Date.now() + ENROLMENT_RETRY_DELAY_MS),
      ...(target.check_after ? { outcome: "modal_bootstrap_acknowledged" } : {}),
      commit: (tx) => wakeEnrolledSandboxJobs(tx, sandboxId, generation, ["launch"]),
    } satisfies JobResult;
  }

  const observation = dispatch?.kind === "reconcile" ? dispatch.observation : undefined;
  const observed = observation?.kind === "present" ? observation.machine.machineId : null;
  const known = target.provider_sandbox_id ?? target.journaled_id;
  if (
    (target.provider_sandbox_id && target.journaled_id && target.provider_sandbox_id !== target.journaled_id) ||
    (known && observed && known !== observed) ||
    (!known &&
      (target.has_intent
        ? !observed || observation?.kind !== "present" || observation.receipt?.operation !== "create"
        : observed !== null))
  ) {
    return {
      status: "retry",
      after: new Date(Date.now() + RECONCILE_DELAY_MS),
      outcome: RECONCILING_ALLOCATION,
    } satisfies JobResult;
  }

  if (!known && observed) {
    const adopted = await withJobLease(sql, job, (tx) => adoptObservedModalAllocation(tx, job, observed));
    if (!adopted) throw new Error("Modal launch observation could not be adopted before cleanup.");
  }

  return {
    status: "fail",
    reason: MODAL_LAUNCH_FAILURE,
    async commit(tx) {
      const current = await readEnrolment(tx);
      if (!current?.starting || current.enrolled) throw new Error("Modal launch settlement target changed.");
      const transition = await transitionSandbox(tx, {
        sandboxId,
        expectedGeneration: generation,
        fromStates: ["starting"],
        toState: "failed",
        actor: "lifecycle_runner",
        code: MODAL_LAUNCH_FAILURE,
        effects: [],
      });
      if (transition.kind !== "applied") throw new Error("Modal launch failure lost its generation.");
      await clearStartingModalStop(tx, sandboxId, generation);
      await createJobsStore(sql, encryptionKey).enqueue(
        "delete",
        sandboxId,
        generation,
        "modal-launch-failure",
        {
          launchJobId: job.id,
          machineId: known ?? observed,
          ...boatAuthorityPayload(job.payload),
        },
        {
          orgId: target.org_id,
          deadline: new Date(Date.now() + DELETE_DISPATCH_BUDGET_MS),
          maxAttempts: job.max_attempts,
        },
        tx,
      );
      await wakeSandboxJobs(tx, sandboxId, [MODAL_INITIAL_TURN], generation);
    },
  } satisfies JobResult;
}

async function dispatchModalLaunch(
  sql: Sql,
  job: Job,
  context: DispatchContext,
  plan: ModalLaunchPlan,
  {
    sandboxId,
    generation,
    awaitingEnrolment,
    handoffStaged,
    ticketIssued,
    replayingTicket,
  }: Pick<MachineIncarnation, "sandboxId" | "generation"> & {
    awaitingEnrolment: boolean;
    handoffStaged: boolean;
    ticketIssued: boolean;
    replayingTicket: boolean;
  },
  resolveRuntimeTicket: (
    request: Parameters<PrepareModalTicket>[0],
    preparation: Awaited<ReturnType<ModalLaunchPlan["prepareRuntimeTicket"]>>,
    handoff: ModalLaunchHandoff | undefined,
    physicalExpiry?: number,
    lockExtra?: (tx: Sql) => Promise<void>,
  ) => ReturnType<PrepareModalTicket>,
  launchAuthorized: (tx: Sql) => Promise<boolean>,
) {
  const { signal, canDispatch } = context;
  const incarnation = { sandboxId, generation, signal };
  const reconciliationOnly =
    typeof job.outcome === "object" &&
    job.outcome !== null &&
    "result" in job.outcome &&
    job.outcome.result === RECONCILING_ALLOCATION;
  const boat = "boat" in plan;
  type Target = { provider_sandbox_id: string | null };
  const ownership = "j.sandbox_id=s.id and j.org_id=s.org_id and j.request_owner_id=s.owner_id";
  const eligible = `s.stop_requested_at is null and s.deleted_at is null and s.expires_at>clock_timestamp()
    and s.status='starting' and (s.runtime_transport='dialout' or s.boat_runtime)`;
  const boatTarget = async (tx: Sql) => {
    if (!boat) return;
    const {
      rows: [row],
    } = await tx.query<Target>(
      `select s.provider_sandbox_id from public.sandboxes s
       join public.jobs j on j.id=$2 and ${ownership}
       join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
       where s.id=$1 and s.provider='boat' and ${eligible}
         and exists(
           select 1 from public.credentials c where c.id=s.credential_id and c.version=s.credential_version
             and c.status='active' and (c.expires_at is null or c.expires_at>clock_timestamp())
             and ((c.scope='org' and c.owner_id=s.org_id) or (c.scope='user' and c.owner_id=s.owner_id))
         ) for share of m`,
      [sandboxId, job.id],
    );
    if (row && (await plan.canUseModalCredential(tx)) && (await canDispatch(tx)) && (await launchAuthorized(tx)))
      return row;
  };
  const modalTarget = async (tx: Sql) => {
    if (boat || signal.aborted) return;
    const { id, version } = await plan.modalCredential();
    const { credentialScope, credentialOwnerId } = plan.placement.managementAuthority;
    const readTarget = async () =>
      (
        await queryWithJobLease<Target & { owner_member: boolean; dispatchable: boolean }>(
          tx,
          job,
          `, member as materialized (
         select s.provider_sandbox_id, exists (
           select 1 from public.members m where m.org_id=j.org_id and m.user_id=j.request_owner_id for share of m
         ) as owner_member
         from locked_sandbox s join locked_job j on ${ownership}
         where ${eligible} and s.provider='modal' and j.lease_until>clock_timestamp()
       ), credential as materialized (
         select expires_at from public.credentials
         where id=$6 and version=$7 and kind='modal' and scope=$8 and owner_id=$9 and status='active'
           and (select owner_member from member)
         for share
       )
       select member.*, case when exists (
         select 1 from credential where expires_at is null or expires_at>clock_timestamp()
       ) then exists (
         select 1 from locked_job j
         where j.lease_owner=$10 and j.lease_until>clock_timestamp() and j.attempts<=j.max_attempts
           and (j.deadline_at is null or j.deadline_at>clock_timestamp())
       ) else false end as dispatchable from member`,
          [id, version, credentialScope, credentialOwnerId, job.lease_owner ?? null],
        )
      ).rows[0];
    let row = await readTarget();
    // WARNING: The membership snapshot may predate acquisition of the sandbox lock.
    if (row && !row.owner_member) row = await readTarget();
    if (row?.dispatchable && !signal.aborted && (await launchAuthorized(tx))) return row;
  };
  const withDispatchTarget = <T>(work: (tx: Sql, row: Target | undefined) => T | Promise<T>) => {
    if (boat) return withJobLease(sql, job, async (tx) => work(tx, await boatTarget(tx)));
    if (!sql.transaction) throw new Error("Job checkpoint requires a transaction.");
    return sql.transaction(async (tx) => work(tx, await modalTarget(tx)));
  };
  const target = () => withDispatchTarget((_tx, row) => row);
  const recovering = hasModalMachineJournal(job);
  const deferred = { kind: "dispatch_deferred" } as const;
  async function canDeferPreparation(machineId: string) {
    const current = await beforeProviderMutation(context, true, target);
    return current === "deferred" || current?.provider_sandbox_id === machineId;
  }
  let recoveredAllocation = false;
  let ticketResolutionStarted = false;
  const preparationDeferred = new Error("Modal runtime ticket preparation deferred.");
  const journal = createJobsStore(sql).modalLaunchJournal(job, (write) =>
    withDispatchTarget(async (tx, row) => row?.provider_sandbox_id === null && write(tx)),
  );
  const modalTicket = {
    async resolveRuntimeTicket(request: Parameters<PrepareModalTicket>[0]) {
      if ("boat" in plan) throw new Error("Modal ticket preparation requires Modal placement.");
      ticketResolutionStarted = true;
      if (ticketIssued && !handoffStaged)
        throw new ModalBootstrapRefused("Modal bootstrap ticket lacks a prepared handoff.");
      if (awaitingEnrolment && !replayingTicket) return null;
      const { preparation, handoff } = await (async () => {
        const preparation = await plan.prepareRuntimeTicket(request);
        const handoff =
          !handoffStaged && (await target())?.provider_sandbox_id === request.machineId
            ? await prepareModalLaunchHandoff(
                request,
                plan.machine,
                plan.placement,
                plan.allocation,
                plan.computeExpiresAt,
                signal,
              )
            : undefined;
        return { preparation, handoff };
      })().catch(async (error: unknown) => {
        if (recoveredAllocation && (await canDeferPreparation(request.machineId))) throw preparationDeferred;
        throw error;
      });
      const canDeferReplay = recoveredAllocation && replayingTicket;
      const ticket = await beforeProviderMutation(context, canDeferReplay, async () => {
        const modalCred = !replayingTicket ? await plan.modalCredential() : undefined;
        const lockModalCredential = modalCred
          ? async (tx: Sql) => {
              const { credentialScope, credentialOwnerId } = plan.placement.managementAuthority;
              const { rows } = await tx.query(
                `select 1 from public.credentials
                 where id=$1 and version=$2 and kind='modal' and scope=$3 and owner_id=$4
                   and status='active' and (expires_at is null or expires_at>clock_timestamp())
                 for share`,
                [modalCred.id, modalCred.version, credentialScope, credentialOwnerId],
              );
              if (!rows.length) throw new ModalBootstrapRefused("Modal bootstrap dispatch is no longer authorized.");
            }
          : undefined;
        return resolveRuntimeTicket(request, preparation, handoff, undefined, lockModalCredential);
      });
      if (ticket === "deferred") throw preparationDeferred;
      if (!ticket) return null;
      if (replayingTicket) {
        const authorized = await beforeProviderMutation(context, canDeferReplay, target);
        if (authorized === "deferred") throw preparationDeferred;
        if (authorized?.provider_sandbox_id !== request.machineId)
          throw new ModalBootstrapRefused("Modal bootstrap dispatch is no longer authorized.");
      }
      return ticket;
    },
  };
  const machine = boat
    ? plan.machine(
        async (request, expiry) => {
          ticketResolutionStarted = true;
          if (awaitingEnrolment && !replayingTicket) return null;
          const preparation = await plan.prepareRuntimeTicket({ ...request, bindingRef: plan.bindingRef });
          return resolveRuntimeTicket({ ...request, bindingRef: plan.bindingRef }, preparation, undefined, expiry);
        },
        async () => {
          if (!(await target())) throw new ModalBootstrapRefused("Boat launch dispatch is no longer authorized.");
        },
      )
    : createModalMachine({ ...plan.machine, journal, ...modalTicket });
  const reconcile = async () => ({ kind: "reconcile", observation: await machine.observe(incarnation) }) as const;

  const current = reconciliationOnly ? undefined : await beforeProviderMutation(context, recovering, target);
  if (current === "deferred") return deferred;
  if (!current) return reconcile();

  const machineId = current.provider_sandbox_id;
  let authorizedMachineId = machineId;
  const observed =
    job.attempts > 1 ? await machine.observe({ ...incarnation, ...(machineId ? { machineId } : {}) }) : undefined;
  if (observed) {
    const confirmed = await beforeProviderMutation(context, recovering, target);
    if (confirmed === "deferred") return deferred;
    if (!confirmed) return { kind: "reconcile", observation: observed } as const;
    authorizedMachineId = confirmed.provider_sandbox_id;
    if (observed.kind === "unknown" || (machineId && observed.kind === "absent"))
      return { kind: "dispatch_deferred" } as const;
  }

  let allocated: MachineIdentity;
  if (machineId) {
    allocated = { sandboxId, generation, machineId };
  } else {
    signal.throwIfAborted();
    if (observed?.kind === "present" && observed.receipt?.operation !== "create")
      return { kind: "dispatch_deferred" } as const;
    let freshBoatIntent = false;
    if (boat && observed?.kind !== "present") {
      const entry = await journal.read(plan.bindingRef);
      if (
        !entry &&
        !(await journal.compareAndSet(plan.bindingRef, undefined, {
          revision: 1,
          operation: "create",
          phase: "creating",
          intent: plan.bindingRef,
        }))
      )
        return deferred;
      freshBoatIntent = !entry;
    }
    try {
      allocated =
        observed?.kind === "present" ? observed.machine : await machine.create({ ...plan.allocation, ...incarnation });
    } catch (error) {
      const refused = freshBoatIntent && isNonMutatingProviderRefusal(error);
      if (!refused || !(await withJobLease(sql, job, (tx) => clearRefusedBoatCreate(tx, job)))) throw error;
      return { kind: "reconcile", observation: { kind: "absent" } } as const;
    }
    if (allocated.sandboxId !== sandboxId || allocated.generation !== generation)
      throw new Error("Modal launch changed the machine incarnation.");
    const bound = await beforeProviderMutation(context, observed?.kind === "present", () =>
      withDispatchTarget(async (tx, row) => {
        if (row?.provider_sandbox_id !== null) return false;
        if (
          (boat || observed?.kind === "present") &&
          !(await adoptObservedModalAllocation(tx, job, allocated.machineId))
        )
          return false;
        return bindModalLaunchMachine(tx, allocated, boat ? "boat" : "modal");
      }),
    );
    if (bound === "deferred") return deferred;
    if (!bound) return observed?.kind === "present" ? { kind: "reconcile", observation: observed } : reconcile();
    authorizedMachineId = allocated.machineId;
  }

  if (observed?.kind === "present" && observed.phase === "stopped")
    return { kind: "reconcile", observation: observed } as const;
  recoveredAllocation = machineId !== null || observed?.kind === "present";
  if (authorizedMachineId !== allocated.machineId) return reconcile();
  signal.throwIfAborted();
  try {
    await machine.bootstrap({ ...allocated, signal, bindingRef: plan.bindingRef });
  } catch (error) {
    if (error === preparationDeferred) return { kind: "dispatch_deferred" } as const;
    if (
      recoveredAllocation &&
      !ticketResolutionStarted &&
      (!(error instanceof ProviderError) || error.retryable) &&
      (await canDeferPreparation(allocated.machineId))
    ) {
      return { kind: "dispatch_deferred" } as const;
    }
    throw error;
  }
  return { kind: "bootstrapped" } as const;
}

export function createModalLaunchCleanupJob(sql: Sql, openMachine: OpenModalMachine) {
  return {
    concurrency: 4,
    async run(job, context) {
      let machine: Awaited<ReturnType<typeof openMachine>> | undefined;
      try {
        return await runFailedModalLaunchDelete(sql, job, context, async () => {
          const {
            rows: [app],
          } = await sql.query<{
            workspace: string;
            environment: string;
            app_id: string;
            app_name: string;
            authority_scope: "org" | "user";
            authority_owner_id: string;
          }>(
            `select g.modal_workspace as workspace, a.environment, a.app_id, a.app_name,
                    a.authority_scope, a.authority_owner_id
             from public.sandboxes s
             join public.goldens g on g.id=s.golden_id and g.org_id=s.org_id and g.provider='modal'
             join public.modal_server_apps a on a.org_id=s.org_id
               and a.app_id=g.modal_app_id and a.environment=g.modal_environment
             where s.id=$1 and s.lifecycle_generation=$2 and (
               (a.authority_scope='org' and a.authority_owner_id=s.org_id)
               or (a.authority_scope='user' and a.authority_owner_id=s.owner_id)
             )`,
            [job.sandbox_id, job.generation],
          );
          if (!app) throw new Error("Modal cleanup App authority is unavailable.");
          context.signal.throwIfAborted();
          machine = await openMachine(
            {
              binding: { workspace: app.workspace, environment: app.environment, appId: app.app_id },
              appName: app.app_name,
              credentialScope: app.authority_scope,
              credentialOwnerId: app.authority_owner_id,
            },
            context.signal,
          );
          return machine;
        });
      } finally {
        machine?.close();
      }
    },
  } satisfies JobKind;
}

export async function settleEnrolledBoatLaunchFailure(
  tx: Sql,
  encryptionKey: string,
  sandboxId: string,
  generation: string,
) {
  const {
    rows: [target],
  } = await tx.query<{ id: string; org_id: string; machine_id: string; boat: BoatAuthority }>(
    `select j.id,s.org_id,s.provider_sandbox_id as machine_id,j.outcome->'boat_authority' as boat
     from public.sandboxes s join public.jobs j on j.sandbox_id=s.id and j.generation=s.lifecycle_generation
       and j.org_id=s.org_id and j.request_owner_id=s.owner_id and j.kind='launch'
     where s.id=$1 and s.lifecycle_generation=$2 and s.boat_runtime and s.status in ('ready','running')
       and j.outcome ? 'boat_authority' and j.outcome #>> '{modal_machine,entry,machineId}'=s.provider_sandbox_id`,
    [sandboxId, generation],
  );
  if (!target) return false;
  const failed = await transitionSandbox(tx, {
    sandboxId,
    expectedGeneration: Number(generation),
    fromStates: ["ready", "running"],
    toState: "failed",
    actor: "lifecycle_runner",
    code: MODAL_LAUNCH_FAILURE,
    effects: [],
  });
  if (failed.kind !== "applied") throw new RuntimeEnrolmentDenied();
  await createJobsStore(tx, encryptionKey).enqueue(
    "delete",
    sandboxId,
    Number(generation),
    "modal-launch-failure",
    { launchJobId: target.id, machineId: target.machine_id, boat: target.boat },
    { orgId: target.org_id, deadline: new Date(Date.now() + DELETE_DISPATCH_BUDGET_MS), maxAttempts: 3 },
    tx,
  );
  return true;
}

export async function runFailedModalLaunchDelete(
  sql: Sql,
  job: Job,
  context: DispatchContext,
  prepareMachine: (() => Promise<ModalMachineRuntime>) | undefined,
  openBoat?: (authorize: () => Promise<void>) => Promise<Machine>,
) {
  const sandboxId = job.sandbox_id;
  const generation = Number(job.generation);
  const payload = job.payload;
  if (
    job.kind !== "delete" ||
    !sandboxId ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !payload ||
    typeof payload !== "object" ||
    !("launchJobId" in payload) ||
    typeof payload.launchJobId !== "string" ||
    !z.uuid().safeParse(payload.launchJobId).success ||
    !("machineId" in payload) ||
    (payload.machineId !== null && typeof payload.machineId !== "string")
  ) {
    return { status: "fail", reason: "invalid_modal_launch_cleanup" } satisfies JobResult;
  }

  const { launchJobId, machineId } = payload;
  const loadTarget = async (tx: Sql) => {
    const { rows } = await tx.query<{ deleted: boolean | null }>(
      `select launch.outcome #>> '{evidence,modal_machine,entry,phase}' = 'deleted' as deleted
       from public.sandboxes s
       join public.jobs cleanup on cleanup.id=$2 and cleanup.org_id=s.org_id
       join public.jobs launch on launch.id=$3 and launch.kind='launch'
         and launch.sandbox_id=s.id and launch.generation=s.lifecycle_generation
         and launch.org_id=s.org_id and launch.request_owner_id=s.owner_id
       where s.id=$1 and s.provider::text=$6 and (s.runtime_transport='dialout' or s.boat_runtime)
         and s.status='failed' and s.deleted_at is null and s.stop_requested_at is null
         and s.status_reason=$5 and (s.provider_sandbox_id is null or s.provider_sandbox_id=$4)
         and (($6='boat' and launch.outcome ? 'boat_authority'
               and launch.outcome #>> '{modal_machine,entry,machineId}'=$4)
           or (launch.state='failed' and launch.outcome->>'reason'=$5 and (
           ($4::text is null and launch.outcome #> '{evidence,modal_machine}' is null)
           or (launch.outcome #>> '{evidence,modal_machine,entry,operation}'='create'
             and (launch.outcome #>> '{evidence,modal_machine,entry,machineId}'=$4
               or (launch.outcome #>> '{evidence,modal_machine,entry,phase}'='creating' and $4 is not null)))
         )))`,
      [sandboxId, job.id, launchJobId, machineId, MODAL_LAUNCH_FAILURE, openBoat ? "boat" : "modal"],
    );
    return rows[0];
  };
  const current = await withJobLease(sql, job, loadTarget);
  if (!current) {
    return { status: "fail", reason: "modal_launch_cleanup_target_changed" } satisfies JobResult;
  }
  context.signal.throwIfAborted();
  const confirmed = {
    status: "done",
    commit: (tx) => recordFailedModalLaunchExit(tx, sandboxId, generation, openBoat ? "boat" : "modal"),
  } satisfies JobResult;
  if (machineId === null || current.deleted) return confirmed;

  const isCurrent = async (tx: Sql) => Boolean(await loadTarget(tx));
  const mayDispatch = () => withJobLease(sql, job, async (tx) => (await isCurrent(tx)) && context.canDispatch(tx));
  const dispatchRevoked = new Error("Modal cleanup dispatch is no longer authorized.");
  const unconfirmed = { status: "fail", reason: "modal_launch_cleanup_unconfirmed" } satisfies JobResult;
  const target = { sandboxId, generation, machineId, signal: context.signal };
  if (openBoat) {
    const machine = await openBoat(async () => {
      if (!(await mayDispatch())) throw dispatchRevoked;
    });
    const observed = await machine.observe(target);
    if (observed.kind === "absent" || (observed.kind === "present" && observed.phase === "stopped")) return confirmed;
    if (!(await mayDispatch())) return unconfirmed;
    await machine.delete({ ...target, scope: "physical-only" });
    return confirmed;
  }
  if (!prepareMachine) throw new Error("Launch cleanup has no Machine placement.");
  let options: ModalMachineRuntime;
  try {
    options = await prepareMachine();
  } catch (error) {
    if (await mayDispatch()) throw error;
    context.signal.throwIfAborted();
    return unconfirmed;
  }
  const machine = createModalMachine({
    ...options,
    client: {
      apps: options.client.apps,
      images: options.client.images,
      cpClient: options.client.cpClient,
      sandboxes: guardModalTermination(options.client.sandboxes, async () => {
        if (!(await mayDispatch())) throw dispatchRevoked;
        context.signal.throwIfAborted();
      }),
    },
    journal: createJobsStore(sql).modalFailedLaunchJournal(job, launchJobId, isCurrent, context.canDispatch),
  });
  const dispatch = await mayDispatch();
  context.signal.throwIfAborted();
  if (dispatch) {
    try {
      await machine.delete({ ...target, scope: "physical-only" });
      return confirmed;
    } catch (error) {
      if (error !== dispatchRevoked) throw error;
    }
  }

  const observed = await machine.observe(target);
  if (
    (observed.kind === "absent" && observed.receipt?.operation === "delete") ||
    (observed.kind === "present" && observed.phase === "stopped")
  )
    return confirmed;
  return unconfirmed;
}

function guardModalTermination(sandboxes: ModalMachineRuntime["client"]["sandboxes"], authorize: () => Promise<void>) {
  return new Proxy(sandboxes, {
    get(service, key) {
      if (key === "fromId") {
        return async (...args: Parameters<typeof service.fromId>) => {
          const sandbox = await service.fromId(...args);
          return new Proxy(sandbox, {
            get(instance, property) {
              if (property === "terminate") {
                return async (...params: Parameters<typeof instance.terminate>) => {
                  await authorize();
                  return instance.terminate(...params);
                };
              }
              const value = Reflect.get(instance, property, instance);
              return typeof value === "function" ? value.bind(instance) : value;
            },
          });
        };
      }
      const value = Reflect.get(service, key, service);
      return typeof value === "function" ? value.bind(service) : value;
    },
  });
}
