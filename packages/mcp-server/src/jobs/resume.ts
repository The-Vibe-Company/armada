import { sha256Hex } from "@armada/auth";
import { decryptSecret, encryptSecret, type Sql, toBytea, VaultError } from "@armada/core/server";
import type { ModalProvider } from "@armada/provider-modal";
import { failTurnReceipt, publishAccountTurnReceipt } from "../account-turn-dispatch.ts";
import type { Caller } from "../caller.ts";
import { createSqlData, type SandboxView } from "../data.ts";
import { createGoldenRuntimeEnvironment } from "../golden-runtime-environment.ts";
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
  publishRuntimeWake,
  stopUnfinishedResume,
  transitionSandbox,
} from "../sandbox-lifecycle.ts";
import { runtimeWakes, SANDBOX_ADMISSION_WAKE, waitForTimeout } from "../wake-bus.ts";
import { resumeDispatchAuthority } from "./resume-authority.ts";
import type { JobKind, JobResult } from "./runner.ts";
import { JOBS_WAKE, recordResumeAuthority, recordResumeBootstrapTicket, withJobLease } from "./store.ts";

type Payload = RuntimeResumeInput & { ownerId: string; orgId: string };
type Operation = {
  source: string;
  target: string;
  watermark: string;
  conversation: string;
  empty: boolean;
  digest: string;
  receipt: RuntimeResumeReceipt | null;
  phase: string;
};
type Ticket = Parameters<Parameters<ModalProvider["runtimeResumeMachine"]>[0]["ticket"]>[0];
type Descriptor = NonNullable<Awaited<ReturnType<Parameters<ModalProvider["runtimeResumeMachine"]>[0]["ticket"]>>>;
const conflict = (message = "Resume is pending. Retry with the same request ID.") =>
  new VaultError("conflict", message);

export function createResumeJob(options: {
  sql: Sql;
  key: string;
  commands: ReturnType<typeof createRuntimeCommands>;
  provider(caller: Caller, sandbox: SandboxView): Promise<ModalProvider>;
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
  const operation = async (db: Sql, sandboxId: string, requestId: string) =>
    (
      await db.query<Operation>(
        `select source_epoch::text as source,target_epoch::text as target,watermark::text,
         conversation_id as conversation,empty_checkpoint as empty,request_hash as digest,receipt,phase
       from public.runtime_resumes where sandbox_id=$1 and request_id=$2`,
        [sandboxId, requestId],
      )
    ).rows[0];

  async function resume(caller: Caller, found: SandboxView, input: RuntimeResumeInput, claim?: RuntimeTurnClaim) {
    if (!sql.transaction) throw new Error("Resume requires transactional admission.");
    const { id, request_id: requestId, prompt } = input;
    const empty = found.conversationIds.length === 0 && !found.taskPromptId;
    const hash = (conversation: string) => sha256Hex(JSON.stringify({ id, requestId, conversation, prompt }));
    const lockAccount = (tx: Sql) => lockRuntimeAccount(tx, caller, found, "Pinned runtime account is unavailable.");
    const admit = async (tx: Sql) => {
      const {
        rows: [row],
      } = await tx.query<{
        generation: string;
        expires_at: Date;
        eligible: boolean;
      }>(
        `select lifecycle_generation::text as generation,expires_at,
           (status='stopped' and stopped_at is not null and stop_requested_at is null and deleted_at is null
            and not application_secret_tainted and activity_lease_id is null
            and coalesce(reconcile_lease_until<=clock_timestamp(),true) and activity_until is null
            and expires_at>clock_timestamp()) as eligible
         from public.sandboxes where id=$1 and owner_id=$2 and org_id=$3 and runtime_transport='dialout'
           and credential_id=$4 and credential_version=$5 for update`,
        [id, caller.userId, found.orgId, found.credentialId, found.credentialVersion],
      );
      if (!row) throw conflict("The retained sandbox or account changed.");
      const prior = await operation(tx, id, requestId);
      if (prior) {
        if (prior.digest !== (await hash(prior.conversation)))
          throw conflict("Reuse the original resume request ID with identical input.");
        return prior;
      }
      if (!row.eligible || String(found.lifecycleGeneration) !== row.generation)
        throw conflict("Resume requires a confirmed retained stop. Another resume may already be in progress.");
      if (await pendingModalStopOutput(tx, id, Number(row.generation)))
        throw conflict("Final stop outputs are awaiting publication.");
      const {
        rows: [checkpoint],
      } = await tx.query<{ epoch: string; watermark: string }>(
        `select e.epoch::text,c.watermark::text from public.runtime_enrolments e
          join public.runtime_checkpoints c on c.sandbox_id=e.sandbox_id and c.epoch=e.epoch
          where e.sandbox_id=$1 and c.completed_at is not null and e.runtime_hash is null
            and c.watermark=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=$1)`,
        [id],
      );
      const conversation = found.conversationIds.at(-1) ?? (empty ? `first_${requestId}` : undefined);
      if (!checkpoint || !conversation || !found.model || !found.reasoningEffort)
        throw conflict("No verified runtime checkpoint and pinned settings are available.");
      await tx.query(
        `insert into public.runtime_resumes(sandbox_id,request_id,source_epoch,target_epoch,watermark,request_hash,
          conversation_id,model,reasoning_effort,empty_checkpoint) values($1,$2,$3,$3::bigint+1,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          requestId,
          checkpoint.epoch,
          checkpoint.watermark,
          await hash(conversation),
          conversation,
          found.model,
          found.reasoningEffort,
          empty,
        ],
      );
      if (!found.credentialId || !found.credentialVersion) throw conflict("Pinned resume account is unavailable.");
      const expiresAt = new Date(row.expires_at).toISOString();
      const payload = toBytea(
        await encryptSecret(
          JSON.stringify({
            ...input,
            ownerId: caller.userId,
            orgId: found.orgId,
          } satisfies Payload),
          key,
        ),
      );
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
            idem_key: requestId,
            max_attempts: 240,
            payload_enc: payload,
            deadline_at: new Date(Math.min(new Date(row.expires_at).getTime(), Date.now() + 240_000)).toISOString(),
          },
        ],
      });
      if (moved.kind !== "applied") throw conflict("Resume admission lost its stopped generation.");
      if (!(await recordResumeAuthority(tx, id, moved.generation, requestId, expiresAt)))
        throw conflict("Resume owner authority changed.");
      return undefined;
    };
    const prior = await operation(sql, id, requestId);
    if (!prior) await environment.validate("modal", { userId: caller.userId, orgId: found.orgId }, id);
    if (prior) {
      if (prior.digest !== (await hash(prior.conversation)))
        throw conflict("Reuse the original resume request ID with identical input.");
      if (prior.receipt) return prior.receipt;
    } else if (claim) {
      await claim.handoffGeneration({
        lockPrerequisites: lockAccount,
        async advance(tx, job) {
          if (job.sandbox_id !== id || (job.payload as { requestId?: string }).requestId !== requestId)
            throw conflict("The queued request changed.");
          if (await admit(tx)) throw conflict();
        },
      });
    } else {
      await sql.transaction(async (tx) => {
        await lockAccount(tx);
        await admit(tx);
      });
    }
    runtimeWakes.notify(JOBS_WAKE);
    const wait = runtimeWakes.watch(SANDBOX_ADMISSION_WAKE);
    const signal = AbortSignal.timeout(30_000);
    try {
      while (!signal.aborted) {
        const current = await operation(sql, id, requestId);
        if (current?.receipt && (await createSqlData(sql)(caller).sandboxes.get(id))) return current.receipt;
        if (current?.phase !== "dispatched") throw conflict("Runtime resume could not be completed.");
        await wait.wait(signal, 250, waitForTimeout);
      }
      throw conflict();
    } finally {
      wait.close();
    }
  }

  const handler: JobKind = {
    concurrency: 8,
    async run(job, context) {
      const { sandbox_id: id, generation: generationText } = job;
      const input = job.payload as Payload | null;
      if (!id || !generationText || !input || input.id !== id)
        return { status: "fail", reason: "resume_intent_missing" };
      const generation = Number(generationText);
      const caller: Caller = { userId: input.ownerId, orgs: [{ orgId: input.orgId, role: "member" }], via: "service" };
      const requestId = input.request_id;
      const op = await operation(sql, id, requestId);
      if (!op || !["dispatched", "complete"].includes(op.phase))
        return { status: "fail", reason: "resume_intent_changed" };
      if (op.receipt) return { status: "done", outcome: {} };
      const retry = { status: "retry", after: new Date(Date.now() + 1_000) } satisfies JobResult;
      const target = async (db: Sql) =>
        (
          await db.query<{ deadline_at: Date; expires_at: Date; ttl: number; cancelled: boolean }>(
            `select j.deadline_at, (j.outcome->>'expiresAt')::timestamptz as expires_at,
               least(86400,greatest(1,ceil(extract(epoch from ((j.outcome->>'expiresAt')::timestamptz-j.created_at)))::integer+120)) as ttl,
               not coalesce(${resumeDispatchAuthority("j", "s")},false) as cancelled
             from public.sandboxes s join public.jobs j on j.sandbox_id=s.id and j.generation=s.lifecycle_generation
             where s.id=$1 and j.id=$2 and s.owner_id=$3 and s.org_id=$4 and s.runtime_transport='dialout'`,
            [id, job.id, input.ownerId, input.orgId],
          )
        ).rows[0];
      const current = await withJobLease(sql, job, target);
      if (!current) return { ...retry, unattempted: true };
      if (current.cancelled || !(await context.canDispatch())) {
        return {
          status: "fail",
          reason: "resume_dispatch_ended",
          outcome: {},
          async commit(tx) {
            await tx.query(
              "update public.runtime_resumes set phase='abandoned' where sandbox_id=$1 and request_id=$2 and receipt is null",
              [id, requestId],
            );
            await stopUnfinishedResume(tx, id, generation);
            await failTurnReceipt(tx, id, requestId, true);
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
      const guard = async (db: Sql) => {
        if ((await target(db))?.cancelled !== false || !(await context.canDispatch(db))) throw conflict();
        signal.throwIfAborted();
      };
      const checkpoint = {
        epoch: op.source,
        watermark: Number(op.watermark),
        conversationId: op.empty ? null : op.conversation,
      };
      const agent = runtimeAgentFor(commands, input.ownerId, sandbox, {
        model: sandbox.model,
        reasoningEffort: sandbox.reasoningEffort,
      });
      const enrolled = async () =>
        authority
          .withOwner(id, input.ownerId, async (_, scope) => scope.epoch, generationText)
          .then(
            (epoch) => epoch === op.target,
            () => false,
          );
      try {
        const provider = await options.provider(caller, sandbox);
        const machine = await provider.runtimeResumeMachine({
          recordId: sandbox.providerSandboxId,
          sandboxId: id,
          generation,
          checkpoint,
          deadlineAt: new Date(current.deadline_at).getTime(),
          async write(work) {
            const saved = await withJobLease(sql, job, async (tx) => {
              await guard(tx);
              await work(tx);
              return true;
            });
            if (!saved) throw conflict();
          },
          async authorize() {
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
              return descriptor;
            }
            const { configuration, ...descriptor } = await options.prepare(sandbox);
            const coverage = await provider.get(sandbox.providerSandboxId, { signal });
            const physicalDeadline = coverage.expiresAt?.getTime();
            if (
              coverage.state !== "ready" ||
              physicalDeadline === undefined ||
              !Number.isFinite(physicalDeadline) ||
              physicalDeadline < new Date(current.expires_at).getTime()
            )
              throw conflict("Restored Modal compute does not cover the sandbox lifetime.");
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
                lockPrerequisites: (tx) =>
                  lockRuntimeAccount(tx, caller, sandbox, "Pinned runtime account is unavailable."),
                async check(tx) {
                  const { rows } = await tx.query(
                    "select 1 from public.jobs where id=$1 and outcome ? 'bootstrap_ticket_enc'",
                    [job.id],
                  );
                  if (rows.length) throw conflict();
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
            if (result.epoch !== op.target) throw conflict("Runtime resume epoch changed.");
            return { ...descriptor, enrolmentToken: result.enrolmentToken };
          },
        });
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
        await agent.health(signal, checkpoint, { expectedEpoch: op.target, assertClaim: guard });
        const command = `resume_${requestId}`;
        if ((await commands.result(input.ownerId, id, command, op.target)).state === "missing") {
          await environment.deliver(
            "modal",
            { userId: input.ownerId, orgId: input.orgId },
            id,
            op.target,
            signal,
            guard,
          );
          await options.prepareGitHub?.(caller, id, guard);
          await options.prepareMcp(caller, id, signal, guard);
          await options.restoreScopedAccess(input.ownerId, id, op.target, generationText, signal, guard);
        }
        const accepted = await agent.prompt(
          {
            sandboxId: sandbox.providerSandboxId,
            harness: sandbox.harness,
            conversationId: op.conversation,
            text: input.prompt,
            signal,
          },
          command,
          op.target,
          (receipt) => {
            if (receipt.conversationId !== op.conversation || !receipt.promptId)
              throw conflict("Runtime conversation changed.");
          },
          guard,
        );
        const receipt = {
          id,
          requestId,
          promptId: accepted.promptId,
          conversationId: op.conversation,
          status: accepted.status,
          resumed: true,
          runtime: { kind: "armada", epoch: op.target },
          sourceCheckpoint: {
            epoch: op.source,
            watermark: checkpoint.watermark,
            ...(op.empty ? { empty: true as const } : {}),
          },
        } satisfies RuntimeResumeReceipt;
        await authority.withOwner(
          id,
          input.ownerId,
          async (tx, scope) => {
            if (scope.epoch !== op.target) throw conflict("Runtime resume epoch changed.");
            await guard(tx);
            await publishRuntimeWake(
              tx,
              id,
              generation,
              requestId,
              receipt.promptId,
              op.empty ? [op.conversation] : sandbox.conversationIds,
              job.id,
            );
            await publishAccountTurnReceipt(tx, id, requestId, await encryptSecret(JSON.stringify(receipt), key));
            await tx.query(
              "update public.runtime_resumes set phase='complete',verified_at=coalesce(verified_at,now()),receipt=$3::jsonb where sandbox_id=$1 and request_id=$2",
              [id, requestId, JSON.stringify(receipt)],
            );
          },
          generationText,
        );
        runtimeWakes.notify(SANDBOX_ADMISSION_WAKE);
        return { status: "done", outcome: {} };
      } catch {
        return retry;
      }
    },
  };
  return { handler, resume };
}
