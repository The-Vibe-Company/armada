import { createHash } from "node:crypto";
import {
  DOCKER_LAUNCH_FAILURE_MESSAGES,
  DockerRetentionEnded,
  dockerWorkspaceReclaimedMessage,
  HARNESS_CAPABILITIES,
  isSandboxProvider,
  ProviderError,
} from "@armada/core";
import {
  decryptSecret,
  encryptSecret,
  failureDiagnostic,
  SANDBOX_STOP_MARGIN_SECONDS,
  type Sql,
  toBytea,
  VaultError,
} from "@armada/core/server";
import type { startBoatRuntime } from "@armada/provider-boat";
import type { ModalProvider } from "@armada/provider-modal";
import { failTurnReceipt, resetResumeTurn } from "../account-turn-dispatch.ts";
import { type AccountTurnQueue, accountTurnInputDigest } from "../account-turn-queue.ts";
import type { Caller } from "../caller.ts";
import { createSqlData, type SandboxView } from "../data.ts";
import { createDockerHostStore } from "../docker-host-store.ts";
import { DockerHostUpgradeRequired, supportsDockerHostProtocol } from "../docker-host-version.ts";
import { createDockerLaunchEnvironment } from "../docker-launch-environment.ts";
import { DockerMachinePending } from "../docker-machine-adapter.ts";
import { createDockerSandboxService } from "../docker-sandbox-service.ts";
import { createGoldenRuntimeEnvironment } from "../golden-runtime-environment.ts";
import type { createObservedBoatProvider } from "../observed-boat.ts";
import { recordOperatorDiagnostic } from "../request-observability.ts";
import { lockRuntimeAccount } from "../runtime-account-admission.ts";
import { runtimeAgentFor } from "../runtime-agent.ts";
import type { createRuntimeCommands } from "../runtime-commands.ts";
import { createRuntimeEnrolments } from "../runtime-enrolment.ts";
import type { RuntimeGitHub } from "../runtime-github.ts";
import type { RuntimeMcp } from "../runtime-mcp.ts";
import type { RuntimeResumeInput, RuntimeResumeReceipt, RuntimeTurnClaim } from "../runtime-resume.ts";
import { requireGenerationHeadroom } from "../sandbox-activity.ts";
import type { RestoreScopedRuntimeAccess } from "../sandbox-armada-access.ts";
import {
  failDockerStartup,
  pendingModalStopOutput,
  prepareResumeGeneration,
  recordBoatResumeCoverage,
  restoreResumeSchedule,
  stopUnfinishedResume,
  transitionSandbox,
} from "../sandbox-lifecycle.ts";
import { ResumeTurnDeferred } from "../tool-error.ts";
import { runtimeWakes, SANDBOX_ADMISSION_WAKE, waitForTimeout } from "../wake-bus.ts";
import { createBoatResumeMachine } from "./boat-resume.ts";
import { resumeDispatchAuthority } from "./resume-authority.ts";
import type { JobKind, JobResult } from "./runner.ts";
import {
  JOBS_WAKE,
  recordResumeAuthority,
  recordResumeBootstrapAcknowledged,
  recordResumeBootstrapTicket,
  wakeEnrolledSandboxJobs,
  withJobLease,
} from "./store.ts";

type DockerSandbox = Awaited<ReturnType<ReturnType<typeof createDockerSandboxService>["get"]>>;

type Payload = {
  ownerId: string;
  orgId: string;
  requestId: string;
  source: string;
  target: string;
  watermark: number;
  conversationId: string | null;
  boatMachineId?: string;
  withoutPrompt?: true;
  retainedWorkspace?: true;
};
type Proof = RuntimeResumeReceipt["sourceCheckpoint"] & { target: string };

function resumeProof(input: Payload) {
  return {
    epoch: input.source,
    target: input.target,
    watermark: input.watermark,
    ...(input.conversationId === null ? { empty: true } : {}),
  } satisfies Proof;
}
type Ticket = Parameters<Parameters<ModalProvider["runtimeResumeMachine"]>[0]["ticket"]>[0];
type ResumePreparation = Promise<Omit<Descriptor, "enrolmentToken"> & { configuration: Record<string, unknown> }>;
type Descriptor = NonNullable<Awaited<ReturnType<Parameters<ModalProvider["runtimeResumeMachine"]>[0]["ticket"]>>>;
const conflict = (message = "Resume is pending. Retry with the same request ID.") =>
  new VaultError("conflict", message);

export function createResumeJob(options: {
  sql: Sql;
  key: string;
  commands: ReturnType<typeof createRuntimeCommands>;
  turns: AccountTurnQueue;
  provider(caller: Caller, sandbox: SandboxView): Promise<ModalProvider>;
  boat?(
    caller: Caller,
    sandbox: SandboxView,
  ): Promise<{
    host: ReturnType<typeof createObservedBoatProvider>;
    bootstrap: typeof startBoatRuntime;
    providerAuthority: string;
    legacyLabels?: Readonly<Record<string, string>>;
    authorize(): Promise<void>;
  }>;
  docker?: {
    prepareResume(actor: { userId: string; orgId: string }, id: string): ResumePreparation;
  };
  prepare(
    sandbox: SandboxView,
  ): Promise<Omit<Descriptor, "enrolmentToken"> & { configuration: Record<string, unknown> }>;
  prepareMcp: RuntimeMcp["prepare"];
  prepareGitHub?: RuntimeGitHub["prepareLaunch"];
  restoreScopedAccess: RestoreScopedRuntimeAccess;
}) {
  const { sql, key, commands } = options;
  const authority = createRuntimeEnrolments(sql, key, { allowDockerIssue: true });
  const dockerHosts = createDockerHostStore(sql, key);
  const environment = createGoldenRuntimeEnvironment(sql, key);
  const admitResume = async (
    caller: Caller,
    found: SandboxView | DockerSandbox,
    requestId: string,
    claim?: RuntimeTurnClaim,
    withoutPrompt = false,
  ) => {
    if (!HARNESS_CAPABILITIES[found.harness].resume)
      throw new VaultError("unavailable", "This harness cannot resume a stopped conversation.");
    if (!sql.transaction) throw new Error("Resume requires transactional admission.");
    const id = found.id;
    const docker = "hostId" in found;
    const provider = found.provider;
    const boatRuntime = !docker && found.boatRuntime;
    if (docker && !options.docker) throw conflict("Docker resume is unavailable.");
    if (isSandboxProvider(provider))
      await environment.validate(provider, { userId: caller.userId, orgId: found.orgId }, id);
    const lockAccount = async (tx: Sql) => {
      await tx.query("set local lock_timeout = '750ms'");
      await tx.query("lock table public.account_turn_queue in row exclusive mode");
      if (docker) {
        await tx.query(
          `select m.user_id from public.members m join public.docker_hosts h on h.org_id=m.org_id
           where h.id=$1 and m.user_id in ($2,h.owner_id) order by m.user_id for update of m`,
          [found.hostId, caller.userId],
        );
      }
      await lockRuntimeAccount(tx, caller, found, "Pinned runtime account is unavailable.");
      if (docker) {
        const host = await tx.query<{ restore_recovery_supported: boolean }>(
          `select restore_recovery_supported from public.docker_hosts where id=$1 and org_id=$2 and installation_id=$3
             and revoked_at is null and hash is not null and draining_at is null for update`,
          [found.hostId, found.orgId, found.installationId],
        );
        if (!host.rows.length) throw conflict("The retained Docker host is unavailable.");
        if (!host.rows[0]?.restore_recovery_supported) throw new DockerHostUpgradeRequired();
      }
    };
    const admit = async (tx: Sql) => {
      const {
        rows: [row],
      } = await tx.query<{ generation: string; expires_at: Date; ordinary_docker_stop: boolean }>(
        `select lifecycle_generation::text as generation,expires_at,
           (provider='docker' and status_reason is null and exists(
             select 1 from public.sandbox_transitions t where t.sandbox_id=sandboxes.id
               and t.generation=sandboxes.lifecycle_generation and t.code='docker_stop_completed'
           )) as ordinary_docker_stop
         from public.sandboxes where id=$1 and owner_id=$2 and org_id=$3 and provider=$6::public.sandbox_provider and provider_sandbox_id=$7
           and (provider='docker' or boat_runtime or runtime_transport='dialout')
           and (provider<>'docker' or (exists(
             select 1 from public.docker_hosts h where h.id=sandboxes.docker_host_id
               and h.installation_id=sandboxes.docker_installation_id and h.revoked_at is null
               and h.hash is not null and h.draining_at is null)
             and not exists(select 1 from public.docker_host_jobs d where d.bound_sandbox_id=sandboxes.id
               and d.bound_operation='delete' and d.outcome is null)
             and exists(
             select 1 from public.docker_machine_bindings b join public.docker_host_jobs a
               on a.request_id=b.daemon_generation and a.host_id=b.host_id and a.bound_sandbox_id=b.sandbox_id
             where b.sandbox_id=sandboxes.id and b.host_id=sandboxes.docker_host_id
               and b.installation_id=sandboxes.docker_installation_id and b.daemon_generation=sandboxes.docker_generation
               and b.machine_generation<=sandboxes.lifecycle_generation
               and a.bound_operation in ('create','restore') and a.outcome='completed'
               and a.cancelled_at is null and a.result_machine_id is not null)))
           and credential_id=$4 and credential_version=$5
           and status='stopped' and stopped_at is not null and stop_requested_at is null and deleted_at is null
           and not application_secret_tainted and activity_lease_id is null and activity_until is null
           and (not boat_runtime or not exists(select 1 from public.jobs stop where stop.sandbox_id=sandboxes.id
             and stop.kind='stop' and stop.generation=sandboxes.lifecycle_generation and stop.state in ('queued','leased')))
           and coalesce(reconcile_lease_until<=clock_timestamp(),true) and expires_at>clock_timestamp() for update`,
        [
          id,
          caller.userId,
          found.orgId,
          found.credentialId,
          found.credentialVersion,
          provider,
          found.providerSandboxId,
        ],
      );
      if (!row || String(found.lifecycleGeneration) !== row.generation)
        throw conflict("Resume requires the admitted retained stop.");
      const generation = requireGenerationHeadroom(row.generation, boatRuntime || docker ? 2 : 1);
      if (await pendingModalStopOutput(tx, id, generation))
        throw conflict("Final stop outputs are awaiting publication.");
      const {
        rows: [checkpoint],
      } = await tx.query<{ epoch: string; prior_epoch: string; watermark: string; retained_workspace: boolean }>(
        `select coalesce(c.epoch,e.epoch)::text as epoch,e.epoch::text as prior_epoch,
            coalesce(c.watermark,archive.watermark)::text as watermark,c.epoch is null as retained_workspace
          from public.runtime_enrolments e
          cross join lateral (select coalesce(max(sequence),0) as watermark from public.runtime_events where sandbox_id=$1) archive
          left join public.runtime_checkpoints c on c.sandbox_id=e.sandbox_id and (not $6::boolean or (c.epoch=e.epoch and c.completed_at is not null))
          where e.sandbox_id=$1 and e.runtime_hash is null
            and (($6::boolean and c.epoch is null and e.epoch>0)
              or (c.completed_at is not null and c.watermark=archive.watermark
            and (c.epoch=e.epoch or exists(select 1 from public.jobs wake
              where wake.sandbox_id=e.sandbox_id and wake.kind='resume'
              and wake.generation between $3::bigint-1 and $3::bigint
              and (wake.state='failed' or (wake.generation<$3::bigint and wake.state in ('queued','leased')))
              and coalesce(wake.outcome->'evidence',wake.outcome)->>'boatMachineId'=$4
              and coalesce(wake.outcome->'evidence',wake.outcome)#>>'{checkpoint,epoch}'=c.epoch::text
              and coalesce(wake.outcome->'evidence',wake.outcome)#>>'{checkpoint,watermark}'=c.watermark::text
              and coalesce(wake.outcome->'evidence',wake.outcome)#>>'{checkpoint,target}'=e.epoch::text)
            or exists(select 1 from public.jobs stop where stop.sandbox_id=e.sandbox_id
              and stop.kind='stop' and stop.state='done' and stop.generation=$3::bigint
              and stop.outcome#>>'{modal_checkpoint,epoch}'=c.epoch::text
              and stop.outcome#>>'{modal_checkpoint,watermark}'=c.watermark::text))))
            and ($5::boolean or exists(select 1 from public.account_turn_queue q
              join public.mcp_actor_epochs a on a.org_id=q.org_id and a.user_id=q.owner_id and a.epoch=q.actor_epoch
              where q.sandbox_id=e.sandbox_id and q.request_id=$2 and q.state='dispatching'
                and q.dispatch_generation=$3::bigint for update of q)) order by c.epoch desc limit 1`,
        [
          id,
          requestId,
          row.generation,
          boatRuntime ? found.providerSandboxId : null,
          withoutPrompt,
          row.ordinary_docker_stop,
        ],
      );
      const conversationId = found.conversationIds.at(-1) ?? null;
      if (!checkpoint || (!conversationId && found.taskPromptId) || !found.model || !found.reasoningEffort)
        throw conflict("No verified runtime checkpoint and pinned settings are available.");
      const expiresAt = new Date(row.expires_at).toISOString();
      const intent: Payload = {
        ownerId: caller.userId,
        orgId: found.orgId,
        requestId,
        source: checkpoint.epoch,
        target: String(BigInt(checkpoint.prior_epoch) + 1n),
        watermark: Number(checkpoint.watermark),
        conversationId,
        ...(checkpoint.retained_workspace ? { retainedWorkspace: true } : {}),
        ...(withoutPrompt ? { withoutPrompt: true } : {}),
        ...(boatRuntime ? { boatMachineId: found.providerSandboxId } : {}),
      };
      const moved = await transitionSandbox(tx, {
        sandboxId: id,
        expectedGeneration: row.generation,
        fromStates: ["stopped"],
        toState: "starting",
        actor: "resume_admission",
        code: "runtime_resume_job_admitted",
        effects: [
          {
            kind: "resume",
            idem_key: provider,
            max_attempts: 240,
            payload_enc: toBytea(await encryptSecret(JSON.stringify(intent), key)),
            deadline_at: new Date(Math.min(new Date(row.expires_at).getTime(), Date.now() + 240_000)).toISOString(),
          },
        ],
      });
      if (moved.kind !== "applied") throw conflict("Resume admission lost its stopped generation.");
      if (
        !(await recordResumeAuthority(
          tx,
          id,
          moved.generation,
          requestId,
          expiresAt,
          resumeProof(intent),
          intent.boatMachineId,
          withoutPrompt,
        ))
      )
        throw conflict("Resume owner authority changed.");
      await prepareResumeGeneration(tx, id, moved.generation);
    };
    if (claim) {
      await claim.handoffGeneration({
        lockPrerequisites: lockAccount,
        async advance(tx, job) {
          if (job.sandbox_id !== id || (job.payload as { requestId?: string }).requestId !== requestId)
            throw conflict("The queued request changed.");
          await admit(tx);
        },
      });
    } else {
      await sql.transaction(async (tx) => {
        await lockAccount(tx);
        await admit(tx);
      });
    }
    runtimeWakes.notify(JOBS_WAKE);
  };

  const wake = async (
    caller: Caller,
    found: SandboxView | DockerSandbox,
    requestId: string,
    claim?: RuntimeTurnClaim,
  ) => {
    await admitResume(caller, found, requestId, claim);
    throw new ResumeTurnDeferred();
  };

  const resumeDocker = async (
    caller: Caller,
    target: {
      id: string;
      owner_id: string;
      org_id: string;
      harness: DockerSandbox["harness"];
      status: string;
      status_reason: string | null;
      docker_host_id: string;
    },
    requestId?: string,
  ) => {
    const { id } = target;
    if (target.owner_id !== caller.userId)
      throw new ProviderError({
        provider: "docker",
        code: "not_found",
        message: "Sandbox not found.",
        retryable: false,
      });
    if (!HARNESS_CAPABILITIES[target.harness].resume)
      throw new VaultError("unavailable", "This harness cannot resume a stopped conversation.");
    if (target.status === "deleted" && dockerWorkspaceReclaimedMessage(target.status_reason))
      throw new DockerRetentionEnded(target.status_reason);
    if (!requestId)
      throw new ProviderError({
        provider: "docker",
        code: "invalid_request",
        message: "Invalid Docker sandbox request.",
        retryable: false,
      });
    const {
      rows: [host],
    } = await sql.query<{ daemon_protocol: number | null }>(
      "select daemon_protocol from public.docker_hosts where id=$1 and org_id=$2",
      [target.docker_host_id, target.org_id],
    );
    if (!supportsDockerHostProtocol(host?.daemon_protocol)) throw new DockerHostUpgradeRequired();
    const sandbox = await createDockerSandboxService(sql).get({ userId: caller.userId, orgId: target.org_id }, id);
    if (sandbox.ownerId !== caller.userId) throw new VaultError("not_found", "No owned Docker resume target.");
    const readReceipt = async () => {
      const {
        rows: [prior],
      } = await sql.query<{ state: string; reason: string | null }>(
        `select j.state,j.outcome->>'reason' as reason from public.jobs j join public.sandboxes s on s.id=j.sandbox_id
           join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
           join public.mcp_actor_epochs e on e.org_id=m.org_id and e.user_id=m.user_id
           where s.id=$1 and s.owner_id=$2 and s.org_id=$3 and j.kind='resume'
             and coalesce(j.outcome->'evidence',j.outcome)->>'requestId'=$4
             and coalesce(j.outcome->'evidence',j.outcome)->>'withoutPrompt'='true'
             and coalesce(j.outcome->'evidence',j.outcome)->>'actorEpoch'=e.epoch::text
           order by j.generation desc limit 1`,
        [id, caller.userId, sandbox.orgId, requestId],
      );
      return prior;
    };
    const wait = runtimeWakes.watch(SANDBOX_ADMISSION_WAKE);
    const signal = AbortSignal.timeout(30_000);
    try {
      let admitted = false;
      while (!signal.aborted) {
        const prior = await readReceipt();
        if (prior?.state === "done") return { id, status: "ready" as const };
        if (prior?.state === "failed")
          throw conflict(prior.reason === "disk_full" ? DOCKER_LAUNCH_FAILURE_MESSAGES.disk : "Docker resume failed.");
        if (!prior && !admitted) {
          try {
            await admitResume(caller, sandbox, requestId, undefined, true);
          } catch (error) {
            if (!(error instanceof VaultError) || error.code !== "conflict" || !(await readReceipt())) throw error;
          }
          admitted = true;
        }
        await wait.wait(signal, 250, waitForTimeout);
      }
      throw conflict();
    } finally {
      wait.close();
    }
  };

  const resume = async (caller: Caller, found: SandboxView, input: RuntimeResumeInput) => {
    const wait = runtimeWakes.watch(SANDBOX_ADMISSION_WAKE);
    const signal = AbortSignal.timeout(30_000);
    const request = { id: found.id, request_id: input.request_id, prompt: input.prompt };
    const digest = accountTurnInputDigest(request);
    let submitted = false;
    try {
      while (!signal.aborted) {
        const {
          rows: [row],
        } = await sql.query<{
          proof: Proof | null;
          state: string;
          input_hash: string;
          result_enc: Uint8Array<ArrayBuffer> | null;
        }>(
          `select j.outcome->'checkpoint' as proof,q.state,q.input_hash,q.result_enc from public.account_turn_queue q
             join public.sandboxes s on s.id=q.sandbox_id and s.owner_id=q.owner_id
               and s.org_id=q.org_id and s.deleted_at is null
             join public.members m on m.org_id=q.org_id and m.user_id=q.owner_id
             join public.mcp_actor_epochs e on e.org_id=q.org_id and e.user_id=q.owner_id and e.epoch=q.actor_epoch
             left join public.jobs j on j.sandbox_id=q.sandbox_id and j.generation=q.queued_generation+1
               and j.kind='resume' and j.state='done' and j.generation=q.dispatch_generation
           where q.sandbox_id=$1 and q.request_id=$2 and q.owner_id=$3`,
          [found.id, request.request_id, caller.userId],
        );
        if (!row) {
          if (submitted) throw new VaultError("not_found", "Resume request ownership changed.");
          if (!(await options.turns.accept(caller, request, { resumeOnly: true }))) throw conflict();
          submitted = true;
          continue;
        }
        if (row.input_hash !== digest) throw conflict("Reuse the original resume request ID with identical input.");
        if (row.state === "failed") throw conflict("The queued resume prompt was cancelled.");
        if (row.result_enc) {
          if (!row.proof) throw conflict("The request is not a retained resume.");
          const { target, ...sourceCheckpoint } = row.proof;
          const result = JSON.parse(await decryptSecret(row.result_enc, key)) as Pick<
            RuntimeResumeReceipt,
            "id" | "promptId" | "conversationId" | "status"
          >;
          return {
            ...result,
            requestId: request.request_id,
            resumed: true,
            runtime: { kind: "armada", epoch: target },
            sourceCheckpoint,
          } satisfies RuntimeResumeReceipt;
        }
        await wait.wait(signal, 250, waitForTimeout);
      }
      throw conflict();
    } finally {
      wait.close();
    }
  };

  const handler: JobKind = {
    concurrency: 8,
    async run(job, context) {
      const { sandbox_id: id, generation: generationText } = job;
      const input = job.payload as Payload | null;
      if (!id || !generationText || !input?.source) return { status: "fail", reason: "resume_intent_missing" };
      const generation = Number(generationText);
      const caller: Caller = { userId: input.ownerId, orgs: [{ orgId: input.orgId, role: "member" }], via: "service" };
      const retry = () => ({ status: "retry", after: new Date(Date.now() + 1_000) }) satisfies JobResult;
      const target = async (db: Sql) =>
        (
          await db.query<{
            deadline_at: Date;
            expires_at: Date;
            ttl: number;
            cancelled: boolean;
            docker: boolean;
            actor_epoch: string;
            restore_failure: string | null;
            boat_restore_dispatched: boolean;
            boat_restore_authority: string | null;
            boat_restore_observed: boolean;
            bootstrap_acknowledged: boolean;
            enrolment_pending: boolean;
          }>(
            `select j.deadline_at, (j.outcome->>'expiresAt')::timestamptz as expires_at,
               case when s.provider='docker' then s.effective_ttl_seconds
               when s.boat_runtime then
                 greatest(1,ceil(extract(epoch from ((j.outcome->>'expiresAt')::timestamptz-clock_timestamp())))::integer+$5::integer)
               else least(86400,greatest(1,ceil(extract(epoch from ((j.outcome->>'expiresAt')::timestamptz-j.created_at)))::integer+120))
               end as ttl,
               s.provider='docker' as docker, j.outcome->>'actorEpoch' as actor_epoch,
               j.outcome->>'restoreFailure' as restore_failure,
               j.outcome ? 'boat_restore_dispatched' as boat_restore_dispatched,
               j.outcome->>'boat_restore_authority' as boat_restore_authority,
               j.outcome ? 'boat_restore_observed' as boat_restore_observed,
               coalesce((j.outcome->>'bootstrap_acknowledged')::boolean, false) as bootstrap_acknowledged,
               exists(
                 select 1 from public.runtime_enrolments e
                 where e.sandbox_id=s.id and e.lifecycle_generation=s.lifecycle_generation
                   and e.runtime_hash is null and e.enrolment_hash is not null and e.enrolment_expires_at>clock_timestamp()
               ) as enrolment_pending,
               not coalesce(${resumeDispatchAuthority("j", "s")},false) as cancelled
             from public.sandboxes s join public.jobs j on j.sandbox_id=s.id and j.generation=s.lifecycle_generation
             where s.id=$1 and j.id=$2 and s.owner_id=$3 and s.org_id=$4 and (s.provider='docker' or s.boat_runtime or s.runtime_transport='dialout')`,
            [id, job.id, input.ownerId, input.orgId, SANDBOX_STOP_MARGIN_SECONDS],
          )
        ).rows[0];
      const current = await withJobLease(sql, job, target);
      if (!current) return { ...retry(), unattempted: true };
      if (current.restore_failure || current.cancelled || !(await context.canDispatch())) {
        return {
          status: "fail",
          reason: current.restore_failure ?? "resume_dispatch_ended",
          outcome: {
            ...(input.withoutPrompt ? { withoutPrompt: true, actorEpoch: current.actor_epoch } : {}),
            requestId: input.requestId,
            checkpoint: resumeProof(input),
            ...(input.boatMachineId ? { boatMachineId: input.boatMachineId } : {}),
            ...(current.boat_restore_dispatched ? { boat_restore_dispatched: true } : {}),
            ...(current.boat_restore_observed ? { boat_restore_observed: true } : {}),
          },
          async commit(tx) {
            if (current.docker) {
              await failDockerStartup(
                tx,
                id,
                generation,
                "docker_startup_failed",
                DOCKER_LAUNCH_FAILURE_MESSAGES.startup,
              );
            } else await stopUnfinishedResume(tx, id, generation, input.boatMachineId !== undefined);
            if (!input.withoutPrompt) await failTurnReceipt(tx, id, input.requestId);
          },
        };
      }
      const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(Math.max(1, new Date(current.deadline_at).getTime() - Date.now())),
      ]);
      const dockerActor = { userId: input.ownerId, orgId: input.orgId };
      const goldenSandbox = current.docker ? null : await createSqlData(sql)(caller).sandboxes.get(id);
      const sandbox = current.docker ? await createDockerSandboxService(sql).get(dockerActor, id) : goldenSandbox;
      if (!sandbox?.model || !sandbox.reasoningEffort || sandbox.lifecycleGeneration !== generation) return retry();
      const providerId = sandbox.provider;
      const isBoat = goldenSandbox?.boatRuntime === true;
      if (isBoat && sandbox.providerSandboxId !== input.boatMachineId) return retry();
      const guard = async (db: Sql) => {
        if ((await target(db))?.cancelled !== false || !(await context.canDispatch(db))) throw conflict();
        signal.throwIfAborted();
      };
      const checkpoint = {
        epoch: input.source,
        watermark: input.watermark,
        conversationId: input.conversationId,
      };
      const agent = runtimeAgentFor(commands, input.ownerId, sandbox, {
        model: sandbox.model,
        reasoningEffort: sandbox.reasoningEffort,
      });
      const enrolled = async () =>
        authority
          .withOwner(id, input.ownerId, async (_, scope) => scope.epoch, generationText)
          .then(
            (epoch) => epoch === input.target,
            () => false,
          );
      const retryWaitingForEnrolment = () =>
        ({
          ...retry(),
          unattempted: true,
          commit: (tx) => wakeEnrolledSandboxJobs(tx, id, generation, ["resume"]),
        }) satisfies JobResult;
      try {
        const isEnrolled = await enrolled();
        if (!isEnrolled && current.bootstrap_acknowledged && current.enrolment_pending) {
          return retryWaitingForEnrolment();
        }
        const boat = isBoat && goldenSandbox ? await options.boat?.(caller, goldenSandbox) : undefined;
        if (
          boat &&
          current.boat_restore_authority !== null &&
          boat.providerAuthority !== current.boat_restore_authority
        )
          throw conflict("Boat resume authority changed.");
        const modalProvider = !isBoat && goldenSandbox ? await options.provider(caller, goldenSandbox) : undefined;
        const provider = boat?.host ?? modalProvider;

        const verifyCoverage = async (machineId: string) => {
          if (!provider) throw conflict("Runtime resume provider is unavailable.");
          const coverage = await provider.get(sandbox.providerSandboxId, { signal });
          const physicalDeadline = coverage.expiresAt?.getTime();
          const minimum = new Date(current.expires_at).getTime() + (isBoat ? SANDBOX_STOP_MARGIN_SECONDS * 1000 : 0);
          if (
            (coverage.state !== "ready" && (!isBoat || coverage.state !== "running")) ||
            (isBoat && (coverage.id !== machineId || coverage.physicalExitConfirmed)) ||
            physicalDeadline === undefined ||
            !Number.isFinite(physicalDeadline) ||
            physicalDeadline < minimum
          )
            throw conflict("Restored compute does not cover the sandbox lifetime.");
          return physicalDeadline;
        };
        const docker =
          current.docker && !isEnrolled ? await dockerHosts.resumeMachineTarget(dockerActor, job) : undefined;
        const binding = {
          recordId: sandbox.providerSandboxId,
          sandboxId: id,
          generation,
          checkpoint,
          deadlineAt: new Date(current.deadline_at).getTime(),
          async write(work: (tx: Sql) => Promise<unknown>) {
            const saved = await withJobLease(sql, job, async (tx) => {
              await guard(tx);
              await work(tx);
              return true;
            });
            if (!saved) throw conflict();
          },
          async authorize() {
            await boat?.authorize();
            await guard(sql);
          },
          async ticket(request: Ticket) {
            if (await enrolled()) return null;
            const saved = (
              await sql.query<{ ticket: string | null }>(
                "select outcome->>'bootstrap_ticket_enc' as ticket from public.jobs where id=$1",
                [job.id],
              )
            ).rows[0]?.ticket;
            if (saved) {
              const descriptor = JSON.parse(await decryptSecret(Buffer.from(saved, "hex"), key)) as Descriptor & {
                machineId: string;
              };
              if (descriptor.machineId !== request.machineId) throw conflict("Runtime bootstrap machine changed.");
              if (boat) await verifyCoverage(request.machineId);
              return descriptor;
            }
            if (docker ? !options.docker : !goldenSandbox) throw conflict();
            const { configuration, ...descriptor } = docker
              ? await options.docker!.prepareResume(dockerActor, id)
              : await options.prepare(goldenSandbox!);
            const physicalDeadline = docker?.expiresAt ?? (await verifyCoverage(request.machineId));
            const result = await authority.issue({
              ownerId: input.ownerId,
              sandboxId: id,
              expectedGeneration: generation,
              ...(docker ? {} : { expectedProviderSandboxId: sandbox.providerSandboxId }),
              commandGrantExpiresAt: physicalDeadline,
              configuration: {
                ...configuration,
                grant: { ...(configuration.grant as object), expiresAt: physicalDeadline },
                ...(!input.retainedWorkspace && {
                  restoreCheckpoint: { ...checkpoint, model: sandbox.model, reasoningEffort: sandbox.reasoningEffort },
                }),
              },
              assertClaim: guard,
              ticketGuard: {
                async lockPrerequisites(tx) {
                  await tx.query("set local lock_timeout = '750ms'");
                  await lockRuntimeAccount(tx, caller, sandbox, "Pinned runtime account is unavailable.");
                },
                async check(tx) {
                  const { rows } = await tx.query(
                    "select 1 from public.jobs where id=$1 and outcome ? 'bootstrap_ticket_enc'",
                    [job.id],
                  );
                  if (rows.length) throw conflict();
                  if (boat) await recordBoatResumeCoverage(tx, id, request.machineId, generation, physicalDeadline);
                },
              },
              async recordIssued(tx, enrolmentToken) {
                const ticket = await encryptSecret(
                  JSON.stringify({ ...descriptor, enrolmentToken, machineId: request.machineId }),
                  key,
                );
                await recordResumeBootstrapTicket(tx, job.id, Buffer.from(ticket).toString("hex"));
              },
            });
            if (result.epoch !== input.target) throw conflict("Runtime resume epoch changed.");
            return { ...descriptor, enrolmentToken: result.enrolmentToken };
          },
        };
        const machine = boat
          ? createBoatResumeMachine(
              boat.host,
              {
                ...binding,
                providerAuthority: boat.providerAuthority,
                ...(boat.legacyLabels ? { legacyLabels: boat.legacyLabels } : {}),
              },
              job.id,
              sql,
              boat.bootstrap,
            )
          : await modalProvider?.runtimeResumeMachine(binding);
        if (docker) {
          await guard(sql);
          const scope = {
            actor: dockerActor,
            hostId: docker.hostId,
            installationId: docker.installationId,
            async canDispatch(tx: Sql) {
              return (await target(tx))?.cancelled === false && (await context.canDispatch(tx));
            },
          };
          const identity = await dockerHosts.machine({ ...scope, restoreClaim: job }).resume({
            sandboxId: id,
            generation,
            size: null,
            computeTtlSeconds: docker.ttl,
            predecessor: docker.predecessor,
            signal,
          });
          const descriptor = await binding.ticket({ ...identity, bindingRef: job.id });
          if (descriptor) {
            const { serverUrl, artifact, enrolmentToken } = descriptor;
            await dockerHosts
              .machine({ ...scope, bootstrapDescriptor: { serverUrl, artifact, enrolmentToken } })
              .bootstrap({
                ...identity,
                bindingRef: createHash("sha256").update(descriptor.enrolmentToken).digest("hex"),
                signal,
              });
          }
          if (!(await enrolled())) {
            await binding.write((tx) => recordResumeBootstrapAcknowledged(tx, job.id));
            return retryWaitingForEnrolment();
          }
        } else if (!isEnrolled) {
          if (!machine) throw conflict();
          await guard(sql);
          const identity = await machine.resume({
            sandboxId: id,
            generation,
            size: null,
            computeTtlSeconds: current.ttl,
            predecessor: machine.predecessor,
            signal,
          });
          if (identity.sandboxId !== id || identity.generation !== generation) throw conflict();
          await machine.bootstrap({ ...identity, bindingRef: job.id, signal });
          if (!(await enrolled())) {
            await binding.write((tx) => recordResumeBootstrapAcknowledged(tx, job.id));
            return retryWaitingForEnrolment();
          }
        }
        await agent.health(signal, input.retainedWorkspace ? undefined : checkpoint, {
          expectedEpoch: input.target,
          assertClaim: guard,
        });
        if (current.docker) await createDockerLaunchEnvironment(sql, key)(caller, id, guard);
        else if (isSandboxProvider(providerId))
          await environment.deliver(
            providerId,
            { userId: input.ownerId, orgId: input.orgId },
            id,
            input.target,
            signal,
            guard,
          );
        await options.prepareGitHub?.(caller, id, guard);
        await options.prepareMcp(caller, id, signal, guard);
        await options.restoreScopedAccess(input.ownerId, id, input.target, generationText, signal, guard);
        if (boat) await verifyCoverage(sandbox.providerSandboxId);
        await guard(sql);
        return {
          status: "done",
          outcome: {
            requestId: input.requestId,
            checkpoint: resumeProof(input),
            ...(input.withoutPrompt ? { withoutPrompt: true, actorEpoch: current.actor_epoch } : {}),
          },
          async commit(tx) {
            await restoreResumeSchedule(tx, id);
            if (!input.withoutPrompt) await resetResumeTurn(tx, id, input.requestId, generationText);
          },
        };
      } catch (error) {
        if (error instanceof DockerMachinePending) return { ...retry(), unattempted: true };
        recordOperatorDiagnostic("jobs.resume.run", failureDiagnostic(error), {
          sandboxId: id,
          operationId: job.id,
          code: "retry",
        });
        return retry();
      }
    },
  };
  return { handler, resume, resumeDocker, wake };
}
