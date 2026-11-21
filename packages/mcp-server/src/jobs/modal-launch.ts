import { HARNESS_KINDS, MACHINE_SIZES, type MemberRole, type ModalBinding, type SandboxStatus } from "@armada/core";
import {
  GoldenError,
  LaunchError,
  type Machine,
  type MachineIdentity,
  type MachineIncarnation,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { createModalMachine, type ModalMachineOptions, scopeKey } from "@armada/provider-modal";
import { z } from "zod";
import type { AccountTurnQueue } from "../account-turn-queue.ts";
import type { createGoldenRuntimeEnvironment } from "../golden-runtime-environment.ts";
import { type OrdinaryLaunchFailure, replayOrdinaryLaunchFailure } from "../ordinary-launch-receipts.ts";
import { RuntimeCommandRefused } from "../runtime-commands.ts";
import type { RuntimeConfigurationTarget } from "../runtime-configuration.ts";
import { createRuntimeEnrolments, type RuntimeTicketGuard } from "../runtime-enrolment.ts";
import {
  bindModalLaunchMachine,
  insertStartingModalSandbox,
  MODAL_LAUNCH_FAILURE,
  type ModalLaunchSandbox,
  transitionSandbox,
} from "../sandbox-lifecycle.ts";
import type { Job, JobContext, JobKind, JobResult } from "./runner.ts";
import { ConflictingJobRequest, createJobsStore, withJobLease } from "./store.ts";

export type ModalLaunchAllocation = Omit<Parameters<Machine["create"]>[0], "sandboxId" | "generation" | "signal">;
export interface ModalLaunchAdmission {
  orgId: string;
  ownerId: string;
  request?: { key: string; digest: string };
  sandbox: ModalLaunchSandbox;
  allocation: ModalLaunchAllocation & { source: { kind: "snapshot" } };
  initialPrompt?: string;
  deadline: Date;
  maxAttempts: number;
}

type ArchivedLaunchReceipt =
  | { receipt: "accepted" | "unknown" }
  | { receipt: "refused"; failure: OrdinaryLaunchFailure };

export const MODAL_INITIAL_TURN = "launch_initial_turn";

// WARNING: Activate only after the receipt backfill and launch runner integration.
export async function admitModalLaunch(sql: Sql, encryptionKey: string, input: ModalLaunchAdmission) {
  if (!sql.transaction) throw new Error("Modal admission requires a transaction.");
  const { orgId, ownerId, sandbox, allocation, request } = input;
  const sandboxId = crypto.randomUUID();
  const generation = 1;
  const store = createJobsStore(sql, encryptionKey);
  const key = request
    ? JSON.stringify(["ordinary", Buffer.from(request.key, "utf8").toString("utf8")])
    : JSON.stringify(["unkeyed", sandboxId]);

  try {
    return await sql.transaction(async (tx) => {
      const {
        rows: [golden],
      } = await tx.query<{
        visibility: "org" | "private";
        provider_snapshot_id: string | null;
        modal_workspace: string;
        modal_environment: string;
        modal_app_id: string;
      }>(
        `select g.visibility, g.provider_snapshot_id, g.modal_workspace, g.modal_environment, g.modal_app_id
         from public.goldens g join public.members m on m.org_id=g.org_id and m.user_id=$3
         where g.id=$1 and g.org_id=$2 and g.provider='modal' and g.removed_at is null
           and (g.visibility='org' or g.owner_id=$3)
         for update of g for share of m`,
        [sandbox.goldenId, orgId, ownerId],
      );
      if (!golden) throw new GoldenError("not_found", "Modal golden not found.");

      const snapshot = allocation.source.ref;
      const modal = {
        workspace: golden.modal_workspace,
        environment: golden.modal_environment,
        appId: golden.modal_app_id,
      };
      if (golden.provider_snapshot_id === snapshot)
        await tx.query("select public.lock_golden_snapshot('modal', $1)", [snapshot]);
      const sourceScope = scopeKey({ orgId, userId: ownerId, visibility: golden.visibility, binding: modal });
      const {
        rows: [image],
      } = await tx.query<{ image_id: string }>(
        `select record->>'imageId' as image_id from public.modal_images
         where scope=$1 and name=$2 and record #>> '{info,status}'='ready'
           and record->>'deleted' is distinct from 'true' and nullif(record->>'imageId','') is not null`,
        [sourceScope, snapshot],
      );
      const jobId = await store.enqueue(
        "launch",
        sandboxId,
        generation,
        key,
        {
          allocation: { ...allocation, source: { kind: "snapshot", ref: image?.image_id } },
          snapshot,
          modal,
        },
        {
          orgId,
          deadline: input.deadline,
          maxAttempts: input.maxAttempts,
          request: { ownerId, digest: request?.digest ?? sandboxId },
        },
        tx,
      );
      const {
        rows: [receipt],
      } = await tx.query<{
        sandbox_id: string;
        status: SandboxStatus | null;
        golden_id: string | null;
        outcome: ArchivedLaunchReceipt | null;
      }>(
        `select j.sandbox_id, s.status, s.golden_id, j.outcome from public.jobs j
         left join public.sandboxes s on s.id=j.sandbox_id and s.org_id=j.org_id and s.owner_id=j.request_owner_id
         where j.id=$1 and j.kind='launch' and j.org_id=$2 and j.request_owner_id=$3`,
        [jobId, orgId, ownerId],
      );
      if (!receipt) throw new Error("Modal launch receipt is missing.");
      if (receipt.sandbox_id !== sandboxId) {
        if (receipt.golden_id && receipt.golden_id !== sandbox.goldenId)
          throw new GoldenError("conflict", "Launch key conflicts with an existing receipt.");
        if (receipt.outcome?.receipt === "refused") throw replayOrdinaryLaunchFailure(receipt.outcome.failure);
        if (receipt.outcome?.receipt === "unknown")
          throw new LaunchError(
            "outcome_unknown",
            `Launch outcome unknown; receipt ${receipt.sandbox_id}. Do not use a new key.`,
          );
        return { sandbox: { id: receipt.sandbox_id, status: receipt.status ?? "deleted" } };
      }

      if (golden.provider_snapshot_id !== snapshot)
        throw new GoldenError("conflict", "Golden snapshot changed during launch preparation.");
      const { rows: sealed } = await tx.query(
        "select 1 from public.golden_snapshot_retirements where provider='modal' and old_snapshot=$1 and sealed",
        [snapshot],
      );
      if (sealed.length) throw new GoldenError("conflict", "Golden snapshot is being retired.");
      if (!image) throw new GoldenError("conflict", "Modal golden snapshot image is unavailable.");

      await insertStartingModalSandbox(
        tx,
        {
          sandboxId,
          orgId,
          ownerId,
          generation,
          snapshot,
          visibility: sandbox.visibility === "private" ? "private" : golden.visibility,
        },
        sandbox,
      );
      await store.enqueue(
        MODAL_INITIAL_TURN,
        sandboxId,
        generation,
        sandboxId,
        { launchJobId: jobId, prompt: input.initialPrompt },
        { orgId, maxAttempts: 3 },
        tx,
      );
      return { sandbox: { id: sandboxId, status: "starting" as const } };
    });
  } catch (error) {
    if (error instanceof ConflictingJobRequest)
      throw new GoldenError("conflict", "Launch key conflicts with an existing receipt.");
    throw error;
  }
}

export function createModalInitialTurnJob(
  sql: Sql,
  queue: Pick<AccountTurnQueue, "acceptInitialLaunch">,
  environment: Pick<ReturnType<typeof createGoldenRuntimeEnvironment>, "deliver">,
) {
  return {
    concurrency: 4,
    async run(job, context) {
      const sandboxId = job.sandbox_id;
      const generation = job.generation;
      const payload = z
        .object({ launchJobId: z.string().uuid(), prompt: z.string().optional() })
        .safeParse(job.payload);
      if (!sandboxId || !generation || !payload.success)
        return { status: "fail", reason: "invalid_modal_initial_turn" };

      const {
        rows: [target],
      } = await sql.query<{
        org_id: string;
        owner_id: string;
        role: MemberRole;
        state: string;
        epoch: string | null;
        accepted: boolean;
      }>(
        `select s.org_id, s.owner_id, m.role, launch.state, runtime.epoch::text as epoch,
                exists(select 1 from public.account_turn_queue q
                       where q.sandbox_id=s.id and q.request_id=intent.id
                         and q.queued_generation=intent.generation and q.owner_id=s.owner_id and q.org_id=s.org_id
                ) as accepted
         from public.jobs intent
         join public.sandboxes s on s.id=intent.sandbox_id and s.lifecycle_generation=intent.generation
           and s.org_id=intent.org_id and s.provider='modal'
         join public.jobs launch on launch.sandbox_id=s.id and launch.generation=intent.generation
           and launch.org_id=s.org_id and launch.request_owner_id=s.owner_id and launch.kind='launch'
           and launch.id=$2
         join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
         left join public.runtime_enrolments runtime on runtime.sandbox_id=s.id
           and runtime.lifecycle_generation=s.lifecycle_generation and runtime.runtime_hash is not null
           and s.status in ('ready','running') and s.stop_requested_at is null and s.deleted_at is null
         where intent.id=$1`,
        [job.id, payload.data.launchJobId],
      );
      if (target?.accepted) return { status: "done" };
      if (!target || target.state === "failed") return { status: "fail", reason: "modal_initial_turn_unavailable" };
      if (!(await context.canDispatch())) return { status: "fail", reason: "modal_initial_turn_budget_exhausted" };
      if (target.state !== "done") return { status: "retry", after: new Date(Date.now() + 1_000), unattempted: true };

      const { epoch } = target;
      if (epoch === null) return { status: "fail", reason: "modal_initial_turn_unavailable" };
      try {
        await environment.deliver(
          "modal",
          { userId: target.owner_id, orgId: target.org_id },
          sandboxId,
          epoch,
          context.signal,
          async (tx) => {
            if (!(await context.canDispatch(tx))) throw new Error("Modal initial turn lost its job claim.");
            const { rows } = await tx.query(
              "select 1 from public.sandboxes where id=$1 and lifecycle_generation=$2 and application_secret_tainted",
              [sandboxId, generation],
            );
            if (!rows.length) throw new VaultError("conflict", "Application-secret restrictions are missing.");
          },
        );
      } catch (error) {
        if (error instanceof RuntimeCommandRefused || (error instanceof VaultError && error.code === "conflict"))
          return { status: "fail", reason: "modal_initial_turn_environment_refused" };
        throw error;
      }

      const { prompt } = payload.data;
      if (prompt === undefined) return { status: "done" };

      try {
        const accepted = await queue.acceptInitialLaunch(
          { userId: target.owner_id, orgs: [{ orgId: target.org_id, role: target.role }], via: "service" },
          { id: sandboxId, request_id: job.id, prompt },
          generation,
          async (tx) => {
            const { rows } = await (tx ?? sql).query(
              `select 1 from public.runtime_enrolments
               where sandbox_id=$1 and lifecycle_generation=$2 and epoch=$3 and runtime_hash is not null`,
              [sandboxId, generation, epoch],
            );
            return rows.length > 0 && context.canDispatch(tx);
          },
        );
        if (accepted) return { status: "done" };
      } catch (error) {
        if (!(error instanceof VaultError) || !["conflict", "not_found", "invalid"].includes(error.code)) throw error;
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

interface ModalLaunchPlan {
  allocation: ModalLaunchAllocation;
  bindingRef: string;
  machine: Omit<ModalMachineRuntime, "resolveRuntimeTicket">;
  canUseModalCredential(tx: Sql): Promise<boolean>;
  prepareRuntimeTicket(
    request: Parameters<PrepareModalTicket>[0],
  ): Promise<
    Omit<ModalTicket, "enrolmentToken"> &
      Pick<IssueRuntimeTicket, "ownerId" | "configuration" | "commandGrantExpiresAt"> &
      Pick<RuntimeTicketGuard, "lockPrerequisites"> & { checkAccountPin(tx: Sql): Promise<void> }
  >;
}

type OpenModalMachine = (
  app: { binding: ModalBinding; appName: string; credentialScope: "org" | "user"; credentialOwnerId: string },
  signal: AbortSignal,
) => Promise<ModalMachineRuntime & { close(): void }>;

export function modalLaunchTicketGuard(sandbox: RuntimeConfigurationTarget) {
  return {
    async lockPrerequisites(tx: Sql) {
      const member = await tx.query("select 1 from public.members where org_id=$1 and user_id=$2 for update", [
        sandbox.orgId,
        sandbox.ownerId,
      ]);
      if (!member.rows.length) throw new Error("Modal launch owner membership is unavailable.");
      const credential = await tx.query(
        `select 1 from public.credentials where id=$1 and version=$2 and kind=any($5::public.credential_kind[])
             and status='active' and (expires_at is null or expires_at>clock_timestamp())
             and ((scope='user' and owner_id=$3) or (scope='org' and owner_id=$4)) for share`,
        [
          sandbox.credentialId,
          sandbox.credentialVersion,
          sandbox.ownerId,
          sandbox.orgId,
          HARNESS_KINDS[sandbox.harness],
        ],
      );
      if (!credential.rows.length) throw new Error("Modal launch account is unavailable.");
    },
    async checkAccountPin(tx: Sql) {
      const current = await tx.query(
        "select 1 from public.sandboxes where id=$1 and credential_id=$2 and credential_version=$3",
        [sandbox.id, sandbox.credentialId, sandbox.credentialVersion],
      );
      if (!current.rows.length) throw new Error("Modal launch account pin changed.");
    },
  };
}

const launchPayload = z.object({
  allocation: z.object({
    source: z.object({ kind: z.literal("snapshot"), ref: z.string().min(1) }),
    size: z.enum(MACHINE_SIZES).nullable(),
    computeTtlSeconds: z.number().int().positive(),
  }),
  snapshot: z.string().min(1),
  modal: z.object({ workspace: z.string().min(1), environment: z.string().min(1), appId: z.string().min(1) }),
});

export function createModalLaunchJob(
  sql: Sql,
  encryptionKey: string,
  openMachine: (
    ...args: Parameters<OpenModalMachine>
  ) => Promise<Awaited<ReturnType<OpenModalMachine>> & Pick<ModalLaunchPlan, "canUseModalCredential">>,
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
                appName: string;
                credentialScope: "org" | "user";
                credentialOwnerId: string;
              }
            >(
              `select s.id, s.org_id as "orgId", s.owner_id as "ownerId", s.provider, s.harness, s.status,
                      s.deleted_at as "deletedAt", s.stop_requested_at as "stopRequestedAt",
                      s.expires_at as "expiresAt", s.credential_id as "credentialId",
                      s.credential_version as "credentialVersion", s.repository_dir as "repositoryDir",
                      s.visibility, a.app_name as "appName", a.authority_scope as "credentialScope",
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
          const { appName, credentialScope, credentialOwnerId, ...sandbox } = target;
          machine = await openMachine({ binding, appName, credentialScope, credentialOwnerId }, context.signal);
          return {
            allocation,
            bindingRef: job.id,
            machine,
            canUseModalCredential: machine.canUseModalCredential,
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

export async function runModalLaunch(
  sql: Sql,
  encryptionKey: string,
  job: Job,
  context: DispatchContext,
  preparePlan: () => ModalLaunchPlan | undefined | Promise<ModalLaunchPlan | undefined>,
) {
  const sandboxId = job.sandbox_id;
  const generation = Number(job.generation);
  if (job.kind !== "launch" || !sandboxId || !Number.isSafeInteger(generation) || generation < 1)
    throw new Error("Invalid Modal launch claim.");

  const readEnrolment = async (tx: Sql) => {
    const {
      rows: [receipt],
    } = await tx.query<{ enrolled: boolean; check_after: string | null }>(
      `select e.runtime_hash is not null as enrolled,
              case when e.enrolment_hash is not null and e.enrolment_expires_at>clock_timestamp()
                     and j.deadline_at>clock_timestamp() and s.expires_at>clock_timestamp()
                then least(e.enrolment_expires_at,j.deadline_at,s.expires_at,clock_timestamp()+interval '1 second')::text
              end as check_after
       from public.sandboxes s
       join public.jobs j on j.id=$2 and j.sandbox_id=s.id and j.generation=s.lifecycle_generation
         and j.org_id=s.org_id and j.request_owner_id=s.owner_id
       join public.runtime_enrolments e on e.sandbox_id=s.id and e.lifecycle_generation=s.lifecycle_generation
       where s.id=$1 and s.provider='modal' and s.runtime_transport='dialout'
         and s.provider_sandbox_id is not null
         and s.status in ('starting','ready','running') and s.deleted_at is null and s.stop_requested_at is null`,
      [sandboxId, job.id],
    );
    return receipt ?? { enrolled: false, check_after: null };
  };
  const done = { status: "done" } satisfies JobResult;
  const beforeDispatch = await withJobLease(sql, job, readEnrolment);
  context.signal.throwIfAborted();
  if (!beforeDispatch || beforeDispatch.enrolled) return done;
  if (beforeDispatch.check_after) {
    return { status: "retry", after: new Date(beforeDispatch.check_after), unattempted: true } satisfies JobResult;
  }

  const startingTarget = async (tx: Sql) => {
    const {
      rows: [row],
    } = await tx.query<{
      org_id: string;
      provider_sandbox_id: string | null;
      journaled_id: string | null;
      has_intent: boolean;
    }>(
      `select s.org_id, s.provider_sandbox_id,
              j.outcome #>> '{modal_machine,entry,machineId}' as journaled_id,
              j.outcome #> '{modal_machine,entry}' is not null as has_intent
       from public.sandboxes s join public.jobs j on j.id=$2 and j.sandbox_id=s.id
         and j.org_id=s.org_id and j.request_owner_id=s.owner_id and j.generation=s.lifecycle_generation
       where s.id=$1 and s.provider='modal' and s.runtime_transport='dialout'
         and s.status='starting' and s.deleted_at is null and s.stop_requested_at is null`,
      [sandboxId, job.id],
    );
    return row;
  };
  const hasJournal = typeof job.outcome === "object" && job.outcome !== null && "modal_machine" in job.outcome;
  let skipProvider = !hasJournal && !(await context.canDispatch());
  let plan: ModalLaunchPlan | undefined;
  if (!skipProvider) {
    try {
      plan = await preparePlan();
    } catch (error) {
      context.signal.throwIfAborted();
      if (await context.canDispatch()) throw error;
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
  const dispatch = plan
    ? await dispatchModalLaunch(sql, job, context, plan, { sandboxId, generation }, async (request) => {
        const { ownerId, configuration, commandGrantExpiresAt, lockPrerequisites, checkAccountPin, ...prepared } =
          await plan.prepareRuntimeTicket(request);
        try {
          const ticket = await enrolments.issue({
            sandboxId,
            ownerId,
            configuration,
            ...(commandGrantExpiresAt === undefined ? {} : { commandGrantExpiresAt }),
            expectedGeneration: generation,
            expectedProviderSandboxId: request.machineId,
            async assertClaim(tx) {
              if (!(await context.canDispatch(tx)))
                throw new Error("Modal bootstrap dispatch is no longer authorized.");
            },
            ticketGuard: {
              lockPrerequisites,
              async check(tx) {
                await checkAccountPin(tx);
                const receipt = await readEnrolment(tx);
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
  const afterDispatch = await withJobLease(sql, job, readEnrolment);
  context.signal.throwIfAborted();
  if (!afterDispatch || afterDispatch.enrolled) return done;
  if (dispatch?.kind === "bootstrapped") {
    return {
      status: "retry",
      after: afterDispatch.check_after
        ? new Date(afterDispatch.check_after)
        : new Date(Date.now() + ENROLMENT_RETRY_DELAY_MS),
    } satisfies JobResult;
  }

  const target = await withJobLease(sql, job, startingTarget);
  context.signal.throwIfAborted();
  if (!target) return { status: "done" } satisfies JobResult;

  const observed = dispatch?.observation.kind === "present" ? dispatch.observation.machine.machineId : null;
  const known = target.provider_sandbox_id ?? target.journaled_id;
  if (
    (target.provider_sandbox_id && target.journaled_id && target.provider_sandbox_id !== target.journaled_id) ||
    (known && observed && known !== observed) ||
    (!known && (target.has_intent ? !observed : observed !== null))
  ) {
    return {
      status: "retry",
      after: new Date(Date.now() + RECONCILE_DELAY_MS),
      outcome: RECONCILING_ALLOCATION,
    } satisfies JobResult;
  }

  return {
    status: "fail",
    reason: MODAL_LAUNCH_FAILURE,
    async commit(tx) {
      if ((await readEnrolment(tx)).enrolled || !(await startingTarget(tx)))
        throw new Error("Modal launch settlement target changed.");
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
      await createJobsStore(sql, encryptionKey).enqueue(
        "delete",
        sandboxId,
        generation,
        "modal-launch-failure",
        { launchJobId: job.id, machineId: known ?? observed },
        {
          orgId: target.org_id,
          deadline: new Date(Date.now() + DELETE_DISPATCH_BUDGET_MS),
          maxAttempts: job.max_attempts,
        },
        tx,
      );
    },
  } satisfies JobResult;
}

async function dispatchModalLaunch(
  sql: Sql,
  job: Job,
  context: DispatchContext,
  plan: ModalLaunchPlan,
  { sandboxId, generation }: Pick<MachineIncarnation, "sandboxId" | "generation">,
  resolveRuntimeTicket: PrepareModalTicket,
) {
  const { signal, canDispatch } = context;
  const incarnation = { sandboxId, generation, signal };
  const reconciliationOnly =
    typeof job.outcome === "object" &&
    job.outcome !== null &&
    "result" in job.outcome &&
    job.outcome.result === RECONCILING_ALLOCATION;
  const dispatchTarget = async (tx: Sql) => {
    const {
      rows: [row],
    } = await tx.query<{ provider_sandbox_id: string | null }>(
      `select s.provider_sandbox_id from public.sandboxes s
         join public.jobs j on j.id=$2 and j.sandbox_id=s.id and j.org_id=s.org_id and j.request_owner_id=s.owner_id
         join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
         where s.id=$1 and s.provider='modal' and s.runtime_transport='dialout'
           and s.stop_requested_at is null and s.deleted_at is null and s.expires_at>clock_timestamp()
           and (s.status='starting' or (s.status in ('ready','running') and s.provider_sandbox_id is not null))
         for share of m`,
      [sandboxId, job.id],
    );
    if (row && (await plan.canUseModalCredential(tx)) && (await canDispatch(tx))) return row;
  };
  const target = () => withJobLease(sql, job, dispatchTarget);
  const machine = createModalMachine({
    ...plan.machine,
    journal: createJobsStore(sql).modalLaunchJournal(
      job,
      async (tx) => (await dispatchTarget(tx))?.provider_sandbox_id === null,
    ),
    async resolveRuntimeTicket(request) {
      const ticket = await resolveRuntimeTicket(request);
      if (ticket && (await target())?.provider_sandbox_id !== request.machineId)
        throw new Error("Modal bootstrap dispatch is no longer authorized.");
      return ticket;
    },
  });
  const reconcile = async () => ({ kind: "reconcile", observation: await machine.observe(incarnation) }) as const;

  const current = reconciliationOnly ? undefined : await target();
  if (!current) return reconcile();

  let allocated: MachineIdentity;
  if (current.provider_sandbox_id) {
    allocated = { sandboxId, generation, machineId: current.provider_sandbox_id };
  } else {
    const observed = job.attempts > 1 ? await machine.observe(incarnation) : undefined;
    if (observed && !(await target())) return reconcile();
    signal.throwIfAborted();
    allocated = await machine.create({ ...plan.allocation, ...incarnation });
    if (
      allocated.sandboxId !== sandboxId ||
      allocated.generation !== generation ||
      (observed?.kind === "present" && observed.machine.machineId !== allocated.machineId)
    )
      throw new Error("Modal launch changed the observed machine identity.");
    const bound = await withJobLease(sql, job, async (tx) => {
      if ((await dispatchTarget(tx))?.provider_sandbox_id !== null) return false;
      return bindModalLaunchMachine(tx, allocated);
    });
    if (!bound) return reconcile();
  }

  const readyToBootstrap = await target();
  if (readyToBootstrap?.provider_sandbox_id !== allocated.machineId) return reconcile();
  signal.throwIfAborted();
  await machine.bootstrap({ ...allocated, signal, bindingRef: plan.bindingRef });
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

async function runFailedModalLaunchDelete(
  sql: Sql,
  job: Job,
  context: DispatchContext,
  prepareMachine: () => Promise<ModalMachineRuntime>,
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
       join public.jobs launch on launch.id=$3 and launch.kind='launch' and launch.state='failed'
         and launch.sandbox_id=s.id and launch.generation=s.lifecycle_generation
         and launch.org_id=s.org_id and launch.request_owner_id=s.owner_id
       where s.id=$1 and s.provider='modal' and s.runtime_transport='dialout'
         and s.status='failed' and s.deleted_at is null and s.stop_requested_at is null
         and launch.outcome->>'reason'=$5
         and (s.provider_sandbox_id is null or s.provider_sandbox_id=$4)
         and (
           ($4::text is null and launch.outcome #> '{evidence,modal_machine}' is null)
           or (launch.outcome #>> '{evidence,modal_machine,entry,operation}'='create'
             and (launch.outcome #>> '{evidence,modal_machine,entry,machineId}'=$4
               or (launch.outcome #>> '{evidence,modal_machine,entry,phase}'='creating' and $4 is not null)))
         )`,
      [sandboxId, job.id, launchJobId, machineId, MODAL_LAUNCH_FAILURE],
    );
    return rows[0];
  };
  const current = await withJobLease(sql, job, loadTarget);
  if (!current) {
    return { status: "fail", reason: "modal_launch_cleanup_target_changed" } satisfies JobResult;
  }
  context.signal.throwIfAborted();
  if (machineId === null || current.deleted) return { status: "done" } satisfies JobResult;

  const isCurrent = async (tx: Sql) => Boolean(await loadTarget(tx));
  const mayDispatch = () => withJobLease(sql, job, async (tx) => (await isCurrent(tx)) && context.canDispatch(tx));
  const dispatchRevoked = new Error("Modal cleanup dispatch is no longer authorized.");
  const unconfirmed = { status: "fail", reason: "modal_launch_cleanup_unconfirmed" } satisfies JobResult;
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
  const target = { sandboxId, generation, machineId, signal: context.signal };
  const dispatch = await mayDispatch();
  context.signal.throwIfAborted();
  if (dispatch) {
    try {
      await machine.delete({ ...target, scope: "physical-only" });
      return { status: "done" } satisfies JobResult;
    } catch (error) {
      if (error !== dispatchRevoked) throw error;
    }
  }

  const observed = await machine.observe(target);
  if (
    (observed.kind === "absent" && observed.receipt?.operation === "delete") ||
    (observed.kind === "present" && observed.phase === "stopped")
  )
    return { status: "done" } satisfies JobResult;
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
