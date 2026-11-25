import { HARNESS_CAPABILITIES, isSandboxProvider } from "@armada/core";
import {
  decryptSecret,
  encryptSecret,
  SANDBOX_STOP_MARGIN_SECONDS,
  type Sql,
  toBytea,
  VaultError,
} from "@armada/core/server";
import type { startBoatRuntime } from "@armada/provider-boat";
import type { ModalProvider } from "@armada/provider-modal";
import { failTurnReceipt, ResumeTurnDeferred, resetResumeTurn } from "../account-turn-dispatch.ts";
import { type AccountTurnQueue, accountTurnInputDigest } from "../account-turn-queue.ts";
import type { Caller } from "../caller.ts";
import { createSqlData, type SandboxView } from "../data.ts";
import { createGoldenRuntimeEnvironment } from "../golden-runtime-environment.ts";
import type { createObservedBoatProvider } from "../observed-boat.ts";
import { lockRuntimeAccount } from "../runtime-account-admission.ts";
import { runtimeAgentFor } from "../runtime-agent.ts";
import type { createRuntimeCommands } from "../runtime-commands.ts";
import { createRuntimeEnrolments } from "../runtime-enrolment.ts";
import type { RuntimeGitHub } from "../runtime-github.ts";
import type { RuntimeMcp } from "../runtime-mcp.ts";
import type { RuntimeResumeInput, RuntimeResumeReceipt, RuntimeTurnClaim } from "../runtime-resume.ts";
import type { RestoreScopedRuntimeAccess } from "../sandbox-armada-access.ts";
import {
  pendingModalStopOutput,
  prepareResumeGeneration,
  recordBoatResumeCoverage,
  restoreResumeSchedule,
  stopUnfinishedResume,
  transitionSandbox,
} from "../sandbox-lifecycle.ts";
import { runtimeWakes, SANDBOX_ADMISSION_WAKE, waitForTimeout } from "../wake-bus.ts";
import { createBoatResumeMachine } from "./boat-resume.ts";
import { resumeDispatchAuthority } from "./resume-authority.ts";
import type { JobKind, JobResult } from "./runner.ts";
import { JOBS_WAKE, recordResumeAuthority, recordResumeBootstrapTicket, withJobLease } from "./store.ts";

type Payload = {
  ownerId: string;
  orgId: string;
  requestId: string;
  source: string;
  target: string;
  watermark: number;
  conversationId: string | null;
  boatMachineId?: string;
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
  prepare(
    sandbox: SandboxView,
  ): Promise<Omit<Descriptor, "enrolmentToken"> & { configuration: Record<string, unknown> }>;
  prepareMcp: RuntimeMcp["prepare"];
  prepareGitHub?: RuntimeGitHub["prepareLaunch"];
  restoreScopedAccess: RestoreScopedRuntimeAccess;
}) {
  const { sql, key, commands } = options;
  const authority = createRuntimeEnrolments(sql, key);
  const environment = createGoldenRuntimeEnvironment(sql, key);
  const wake = async (caller: Caller, found: SandboxView, requestId: string, claim?: RuntimeTurnClaim) => {
    if (!HARNESS_CAPABILITIES[found.harness].resume)
      throw new VaultError("unavailable", "This harness cannot resume a stopped conversation.");
    if (!sql.transaction) throw new Error("Resume requires transactional admission.");
    const id = found.id;
    if (!isSandboxProvider(found.provider)) throw conflict();
    const provider = found.provider;
    await environment.validate(provider, { userId: caller.userId, orgId: found.orgId }, id);
    const lockAccount = async (tx: Sql) => {
      await tx.query("set local lock_timeout = '750ms'");
      await tx.query("lock table public.account_turn_queue in row exclusive mode");
      await lockRuntimeAccount(tx, caller, found, "Pinned runtime account is unavailable.");
    };
    const admit = async (tx: Sql) => {
      const {
        rows: [row],
      } = await tx.query<{ generation: string; expires_at: Date }>(
        `select lifecycle_generation::text as generation,expires_at
         from public.sandboxes where id=$1 and owner_id=$2 and org_id=$3 and provider=$6::public.sandbox_provider and provider_sandbox_id=$7
           and (boat_runtime or runtime_transport='dialout')
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
      if (await pendingModalStopOutput(tx, id, Number(row.generation)))
        throw conflict("Final stop outputs are awaiting publication.");
      const {
        rows: [checkpoint],
      } = await tx.query<{ epoch: string; prior_epoch: string; watermark: string }>(
        `select c.epoch::text,e.epoch::text as prior_epoch,c.watermark::text from public.runtime_enrolments e
          join public.runtime_checkpoints c on c.sandbox_id=e.sandbox_id
          where e.sandbox_id=$1 and c.completed_at is not null and e.runtime_hash is null
            and c.watermark=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=$1)
            and (c.epoch=e.epoch or exists(select 1 from public.jobs wake
              where wake.sandbox_id=e.sandbox_id and wake.kind='resume'
              and wake.generation between $3::bigint-1 and $3
              and (wake.state='failed' or (wake.generation<$3 and wake.state in ('queued','leased')))
              and coalesce(wake.outcome->'evidence',wake.outcome)->>'boatMachineId'=$4
              and coalesce(wake.outcome->'evidence',wake.outcome)#>>'{checkpoint,epoch}'=c.epoch::text
              and coalesce(wake.outcome->'evidence',wake.outcome)#>>'{checkpoint,watermark}'=c.watermark::text
              and coalesce(wake.outcome->'evidence',wake.outcome)#>>'{checkpoint,target}'=e.epoch::text)
            or exists(select 1 from public.jobs stop where stop.sandbox_id=e.sandbox_id
              and stop.kind='stop' and stop.state='done' and stop.generation=$3
              and stop.outcome#>>'{modal_checkpoint,epoch}'=c.epoch::text
              and stop.outcome#>>'{modal_checkpoint,watermark}'=c.watermark::text))
            and exists(select 1 from public.account_turn_queue q
              join public.mcp_actor_epochs a on a.org_id=q.org_id and a.user_id=q.owner_id and a.epoch=q.actor_epoch
              where q.sandbox_id=e.sandbox_id and q.request_id=$2 and q.state='dispatching'
                and q.dispatch_generation=$3 for update of q) order by c.epoch desc limit 1`,
        [id, requestId, row.generation, found.boatRuntime ? found.providerSandboxId : null],
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
        ...(found.boatRuntime ? { boatMachineId: found.providerSandboxId } : {}),
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
    throw new ResumeTurnDeferred();
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
      const retry = { status: "retry", after: new Date(Date.now() + 1_000) } satisfies JobResult;
      const target = async (db: Sql) =>
        (
          await db.query<{
            deadline_at: Date;
            expires_at: Date;
            ttl: number;
            cancelled: boolean;
            boat_restore_dispatched: boolean;
            boat_restore_authority: string | null;
            boat_restore_observed: boolean;
          }>(
            `select j.deadline_at, (j.outcome->>'expiresAt')::timestamptz as expires_at,
               case when s.boat_runtime then
                 greatest(1,ceil(extract(epoch from ((j.outcome->>'expiresAt')::timestamptz-clock_timestamp())))::integer+$5::integer)
               else least(86400,greatest(1,ceil(extract(epoch from ((j.outcome->>'expiresAt')::timestamptz-j.created_at)))::integer+120))
               end as ttl,
               j.outcome ? 'boat_restore_dispatched' as boat_restore_dispatched,
               j.outcome->>'boat_restore_authority' as boat_restore_authority,
               j.outcome ? 'boat_restore_observed' as boat_restore_observed,
               not coalesce(${resumeDispatchAuthority("j", "s")},false) as cancelled
             from public.sandboxes s join public.jobs j on j.sandbox_id=s.id and j.generation=s.lifecycle_generation
             where s.id=$1 and j.id=$2 and s.owner_id=$3 and s.org_id=$4 and (s.boat_runtime or s.runtime_transport='dialout')`,
            [id, job.id, input.ownerId, input.orgId, SANDBOX_STOP_MARGIN_SECONDS],
          )
        ).rows[0];
      const current = await withJobLease(sql, job, target);
      if (!current) return { ...retry, unattempted: true };
      if (current.cancelled || !(await context.canDispatch())) {
        return {
          status: "fail",
          reason: "resume_dispatch_ended",
          outcome: {
            requestId: input.requestId,
            checkpoint: resumeProof(input),
            ...(input.boatMachineId ? { boatMachineId: input.boatMachineId } : {}),
            ...(current.boat_restore_dispatched ? { boat_restore_dispatched: true } : {}),
            ...(current.boat_restore_observed ? { boat_restore_observed: true } : {}),
          },
          async commit(tx) {
            await stopUnfinishedResume(tx, id, generation, input.boatMachineId !== undefined);
            await failTurnReceipt(tx, id, input.requestId);
          },
        };
      }
      const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(Math.max(1, new Date(current.deadline_at).getTime() - Date.now())),
      ]);
      const store = createSqlData(sql)(caller).sandboxes;
      const sandbox = await store.get(id);
      if (!sandbox?.model || !sandbox.reasoningEffort || sandbox.lifecycleGeneration !== generation) return retry;
      const providerId = sandbox.provider;
      if (!isSandboxProvider(providerId)) return retry;
      const isBoat = sandbox.boatRuntime === true;
      if (isBoat && sandbox.providerSandboxId !== input.boatMachineId) return retry;
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
      try {
        const boat = isBoat ? await options.boat?.(caller, sandbox) : undefined;
        if (
          boat &&
          current.boat_restore_authority !== null &&
          boat.providerAuthority !== current.boat_restore_authority
        )
          throw conflict("Boat resume authority changed.");
        const modalProvider = isBoat ? undefined : await options.provider(caller, sandbox);
        const provider = boat?.host ?? modalProvider;
        if (!provider) throw conflict("Runtime resume provider is unavailable.");
        const verifyCoverage = async (machineId: string) => {
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
            const { configuration, ...descriptor } = await options.prepare(sandbox);
            const physicalDeadline = await verifyCoverage(request.machineId);
            const result = await authority.issue({
              ownerId: input.ownerId,
              sandboxId: id,
              expectedGeneration: generation,
              expectedProviderSandboxId: sandbox.providerSandboxId,
              commandGrantExpiresAt: physicalDeadline,
              configuration: {
                ...configuration,
                grant: { ...(configuration.grant as object), expiresAt: physicalDeadline },
                restoreCheckpoint: { ...checkpoint, model: sandbox.model, reasoningEffort: sandbox.reasoningEffort },
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
        if (!machine) throw conflict();
        if (!(await enrolled())) {
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
          if (!(await enrolled())) return retry;
        }
        await agent.health(signal, checkpoint, { expectedEpoch: input.target, assertClaim: guard });
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
          outcome: { requestId: input.requestId, checkpoint: resumeProof(input) },
          async commit(tx) {
            await restoreResumeSchedule(tx, id);
            await resetResumeTurn(tx, id, input.requestId, generationText);
          },
        };
      } catch {
        return retry;
      }
    },
  };
  return { handler, resume, wake };
}
