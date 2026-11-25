import { createHash } from "node:crypto";
import type { GoldenActor, LaunchCredentialResolver, Sql } from "@armada/core";
import { DockerRetentionEnded, dockerWorkspaceReclaimedMessage, HARNESS_KINDS } from "@armada/core";
import type { MachineIdentity } from "@armada/core/server";
import { decryptSecret } from "@armada/core/server";
import { requirePublishedRuntimeArchitecture } from "../../agent-runtime/src/publication.ts";
import { type BootstrapDescriptor, dockerMachineJobId, parseDockerHostJob } from "../../core/src/docker-host-job.ts";
import { admitDockerCapacity, DockerHostDraining, DockerHostFull, DockerLimitsRefused } from "./docker-capacity.ts";
import { createDockerHostStore, DOCKER_JOB_REQUEST_OUTCOME_SQL } from "./docker-host-store.ts";
import { DockerMachinePending } from "./docker-machine-adapter.ts";
import { dockerRuntimeConfiguration } from "./docker-runtime-configuration.ts";
import { createDockerSandboxService } from "./docker-sandbox-service.ts";
import type { JobContext } from "./jobs/runner.ts";
import type { RuntimeConfigurationInput } from "./runtime-configuration.ts";
import { createRuntimeEnrolments, scopedRuntimeSql } from "./runtime-enrolment.ts";
import type { RuntimeTurnClaim } from "./runtime-resume.ts";
import { transitionSandbox } from "./sandbox-lifecycle.ts";

type Actor = { userId: string; orgId: string };
type Stored = {
  request_id: string;
  input_enc: Uint8Array<ArrayBuffer>;
  outcome: "completed" | "failed" | null;
};
type Options = {
  enabled?: boolean;
  serverUrl: string;
  manifest: unknown;
  architecture: "x64" | "arm64";
  credentials: Pick<LaunchCredentialResolver, "resolve" | "admit">;
  modelAuth?: RuntimeConfigurationInput["modelAuth"];
};
export class DockerBootstrapDenied extends Error {
  constructor() {
    super("Docker bootstrap denied");
    this.name = "DockerBootstrapDenied";
  }
}
function deny(): never {
  throw new DockerBootstrapDenied();
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Private opt-in composition, not a placement provider or a public launch route. */
export function createDockerBootstrapService(sql: Sql, key: string, options: Options) {
  requirePublishedRuntimeArchitecture(options.architecture);
  // Freeze trusted launch inputs across asynchronous credential admission.
  const manifest = structuredClone(options.manifest);
  const serverUrl = options.serverUrl;
  const architecture = options.architecture;
  async function phase(tx: Sql, sandboxId: string, requestId?: string) {
    return (
      await tx.query<Stored>(
        `select request_id,input_enc,${DOCKER_JOB_REQUEST_OUTCOME_SQL} as outcome
         from public.docker_host_jobs j
         where bound_sandbox_id=$1 and (bound_operation='bootstrap' and $2::uuid is null or bound_operation='resume' and request_id=$2)`,
        [sandboxId, requestId ?? null],
      )
    ).rows[0];
  }
  async function restoreCheckpoint(tx: Sql, sandboxId: string) {
    const row = (
      await tx.query<{
        status_reason: string | null;
        tainted: boolean;
        conversation_ids: string[];
        model: string;
        reasoning_effort: string;
        epoch: string | null;
        watermark: string | null;
        archive: string;
      }>(
        `select s.status_reason,s.application_secret_tainted as tainted,s.conversation_ids,s.model,s.reasoning_effort,
       r.epoch::text,p.watermark::text,(select coalesce(max(sequence),0)::text from public.runtime_events where sandbox_id=s.id) as archive
       from public.sandboxes s left join public.runtime_enrolments r on r.sandbox_id=s.id
       left join public.runtime_checkpoints p on p.sandbox_id=s.id and p.epoch=r.epoch where s.id=$1`,
        [sandboxId],
      )
    ).rows[0];
    if (!row) deny();
    if (row.watermark === null) {
      if (row.status_reason === "idle_paused" || row.status_reason === "work_merged") deny();
      return undefined;
    }
    if (row.tainted) deny();
    const watermark = Number(row.watermark);
    if (
      !row.epoch ||
      row.watermark !== row.archive ||
      !Number.isSafeInteger(watermark) ||
      watermark < 0 ||
      row.conversation_ids.length !== 1 ||
      !uuid.test(row.conversation_ids[0] ?? "") ||
      !row.model ||
      !row.reasoning_effort
    )
      deny();
    return {
      epoch: row.epoch,
      watermark,
      conversationId: row.conversation_ids[0]!,
      model: row.model,
      reasoningEffort: row.reasoning_effort,
    };
  }
  async function bootstrap(
    actor: Actor,
    sandboxId: string,
    requestId: string,
    resume = false,
    turnClaim?: RuntimeTurnClaim,
    machine?: { target: MachineIdentity; context: JobContext },
  ) {
    try {
      if (options.enabled !== true || !uuid.test(requestId) || !sql.transaction) deny();
      // This read must precede resolution: an admin may diagnose, but not bootstrap, an owner's sandbox.
      const snapshot = await createDockerSandboxService(sql).get(actor, sandboxId);
      if (snapshot.ownerId !== actor.userId) deny();
      if (resume && snapshot.status === "deleted" && dockerWorkspaceReclaimedMessage(snapshot.statusReason))
        throw new DockerRetentionEnded(snapshot.statusReason);
      const member =
        (
          await sql.query<{ role: GoldenActor["role"] }>(
            `select role from public.members where org_id=$1 and user_id=$2`,
            [actor.orgId, actor.userId],
          )
        ).rows[0] ?? deny();
      const launchActor: GoldenActor = { ...actor, role: member.role };
      if (!/^https:\/\/[^\\/?#]+\/?$/i.test(serverUrl)) deny();
      const url = new URL(serverUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
        deny();
      if (machine) requestId = dockerMachineJobId(snapshot.generation, "bootstrap");
      const known = await phase(sql, sandboxId, resume ? requestId : undefined);
      if (!known) {
        const acknowledged = await sql.query(
          `select 1 from public.docker_host_jobs where bound_sandbox_id=$1 and bound_operation='create'
             and bound_actor_id=$2 and outcome='completed'`,
          [sandboxId, actor.userId],
        );
        if (!acknowledged.rows.length) deny();
      }
      let handoff = false;
      if (resume && !known) {
        const physicalClaim = await sql.query<{ accepted: boolean | null }>(
          `select accepted from public.docker_resume_claims where request_id=$1 and sandbox_id=$2 and actor_id=$3`,
          [requestId, sandboxId, actor.userId],
        );
        const accepted = physicalClaim.rows[0]?.accepted;
        if (accepted === false) throw new DockerRetentionEnded();
        handoff = turnClaim !== undefined && accepted === true;
      }
      const restore = resume && !known ? await restoreCheckpoint(sql, sandboxId) : undefined;
      let projected: Awaited<ReturnType<typeof dockerRuntimeConfiguration>> | undefined;
      if (!known) {
        if (resume && (snapshot.status !== "stopped" || snapshot.deletedAt !== null)) deny();
        const credentials = await options.credentials.resolve(
          launchActor,
          snapshot.harness,
          snapshot.credentialId,
          snapshot.credentialVersion,
        );
        await options.credentials.admit?.(launchActor, credentials, sandboxId);
        projected = await dockerRuntimeConfiguration({
          actor: launchActor,
          sandbox: resume ? { ...snapshot, status: "starting", stopRequestedAt: null } : snapshot,
          credentials,
          manifest,
          architecture,
          ...(options.modelAuth ? { modelAuth: options.modelAuth } : {}),
        });
        if (restore) Object.assign(projected.configuration, { restoreCheckpoint: restore });
      }
      async function lockPrerequisites(tx: Sql) {
        const hint =
          (
            await tx.query<{ issuer_id: string }>(
              `select h.owner_id as issuer_id from public.sandboxes s join public.docker_hosts h
               on h.id=s.docker_host_id where s.id=$1 and s.org_id=$2 and s.owner_id=$3`,
              [sandboxId, actor.orgId, actor.userId],
            )
          ).rows[0] ?? deny();
        const members = await tx.query<{ user_id: string }>(
          `select user_id from public.members where org_id=$1 and user_id in ($2,$3)
             order by user_id for update`,
          [actor.orgId, actor.userId, hint.issuer_id],
        );
        const locked = new Set(members.rows.map((m) => m.user_id));
        if (!locked.has(actor.userId) || !locked.has(hint.issuer_id)) deny();
        // Credential locking precedes host/sandbox/runtime locks. Historical retries need no account.
        if (!known) {
          const credential = await tx.query(
            `select id from public.credentials where id=$1 and version=$2 and kind = any($5::public.credential_kind[])
               and status='active' and (expires_at is null or expires_at>now())
               and ((scope='user' and owner_id=$3) or (scope='org' and owner_id=$4)) for share`,
            [
              snapshot.credentialId,
              snapshot.credentialVersion,
              actor.userId,
              actor.orgId,
              HARNESS_KINDS[snapshot.harness],
            ],
          );
          if (!credential.rows.length) deny();
        }
        const host = await tx.query<{ id: string; draining_at: string | null }>(
          `select id,draining_at from public.docker_hosts where id=$1 and org_id=$2 and owner_id=$3 and installation_id=$4
             and hash is not null and registration_hash is null and revoked_at is null for update`,
          [snapshot.hostId, actor.orgId, hint.issuer_id, snapshot.installationId],
        );
        if (!host.rows.length) deny();
        if (host.rows[0]!.draining_at) throw new DockerHostDraining();
      }

      async function requireTurnClaim(tx: Sql) {
        if (turnClaim && !(await turnClaim.canDispatch(tx))) deny();
      }

      async function admit(tx: Sql) {
        const scoped = scopedRuntimeSql(tx);
        async function requireStableSandbox() {
          const current = await createDockerSandboxService(scoped).get(actor, sandboxId);
          const enrolledDuringReplay = machine && known && snapshot.status === "starting" && current.status === "ready";
          const expected = enrolledDuringReplay ? { ...snapshot, status: "ready" } : snapshot;
          if (JSON.stringify(current) !== JSON.stringify(expected) || (turnClaim && current.stopRequestedAt !== null))
            deny();
          return current;
        }
        if (turnClaim) {
          if (!handoff) await tx.query("select id from public.sandboxes where id=$1 for update", [sandboxId]);
          await requireStableSandbox();
          if (!handoff) await requireTurnClaim(tx);
        }
        // A stopped generation is only admitted after the host has durably
        // excluded cleanup. Until then this is a request, not a lifecycle change.
        let acceptedGeneration: string | undefined;
        if (resume && !known) {
          const cancelled = await tx.query(
            "select 1 from public.account_turn_queue where sandbox_id=$1 and request_id=$2 and state='failed'",
            [sandboxId, requestId],
          );
          if (cancelled.rows.length) deny();
          await admitDockerCapacity(tx, snapshot.hostId);
          const claim = await tx.query<{ accepted: boolean | null; lifecycle_generation: string }>(
            `insert into public.docker_resume_claims(request_id,sandbox_id,host_id,installation_id,generation,actor_id,lifecycle_generation)
             select $1,id,docker_host_id,docker_installation_id,docker_generation,$3,lifecycle_generation from public.sandboxes
             where id=$2 and owner_id=$3 and status='stopped' and deleted_at is null and expires_at>now()
               and lifecycle_generation between 1 and $4::bigint
             on conflict(request_id) do update set request_id=excluded.request_id
             where docker_resume_claims.sandbox_id=excluded.sandbox_id and docker_resume_claims.actor_id=excluded.actor_id and docker_resume_claims.host_id=excluded.host_id
             and docker_resume_claims.installation_id=excluded.installation_id and docker_resume_claims.generation=excluded.generation
             and docker_resume_claims.lifecycle_generation=excluded.lifecycle_generation
             returning accepted,lifecycle_generation::text`,
            // Reserve the resume admission and its failure fence before asking the daemon to claim.
            [requestId, sandboxId, actor.userId, Number.MAX_SAFE_INTEGER - 2],
          );
          if (!claim.rows.length) deny();
          if (claim.rows[0]!.accepted === false) throw new DockerRetentionEnded();
          if (claim.rows[0]!.accepted !== true || (turnClaim && !handoff)) {
            if (handoff) deny();
            await requireTurnClaim(tx);
            return { requestId, operation: "resume" as const, state: "claiming" as const };
          }
          acceptedGeneration = claim.rows[0]!.lifecycle_generation;
        }
        if (!turnClaim) await tx.query(`select id from public.sandboxes where id=$1 for update`, [sandboxId]);
        const current = await requireStableSandbox();
        if (machine && (!(await machine.context.canDispatch(tx)) || current.stopRequestedAt !== null)) deny();
        const original = await tx.query(
          `select 1 from public.docker_host_jobs j join public.mcp_actor_epochs e
             on e.org_id=$3 and e.user_id=$2 and e.epoch=j.bound_actor_epoch
             where j.bound_sandbox_id=$1 and j.bound_operation='create' and j.bound_actor_id=$2
             and j.host_id=$4 and j.outcome='completed'`,
          [sandboxId, actor.userId, actor.orgId, current.hostId],
        );
        if (!original.rows.length) deny();
        const refused = await tx.query(
          "select 1 from public.account_turn_queue where sandbox_id=$1 and request_id=$2 and state='failed'",
          [sandboxId, requestId],
        );
        if (refused.rows.length) deny();
        const existing = await phase(tx, sandboxId, resume ? requestId : undefined);
        let descriptor: BootstrapDescriptor;
        if (existing) {
          if (existing.request_id !== requestId) deny();
          // Only decrypt after current owner/member/host admission; the bound store then
          // revalidates epoch, physical identity and every immutable canonical job byte.
          const envelope = JSON.parse(await decryptSecret(existing.input_enc, key));
          if (!envelope || Object.keys(envelope).sort().join() !== "bound,job" || envelope.bound !== 1) deny();
          const job = parseDockerHostJob({ ...envelope.job, requestId });
          if (job.operation !== (resume ? "resume" : "bootstrap")) deny();
          const artifact = (manifest as { runtime?: { sha256?: unknown; bytes?: unknown } })?.runtime;
          if (
            job.bootstrap.serverUrl !== url.origin ||
            job.bootstrap.artifact.sha256 !== artifact?.sha256 ||
            job.bootstrap.artifact.bytes !== artifact?.bytes
          )
            deny();
          descriptor = job.bootstrap;
        } else {
          if (!projected) deny();
          // A runtime without this service's bound phase is not ours to replace.
          const occupied = await tx.query(`select 1 from public.runtime_enrolments where sandbox_id=$1`, [sandboxId]);
          if (occupied.rows.length && !resume) deny();
          if (resume) {
            await admitDockerCapacity(tx, current.hostId);
            if (JSON.stringify(await restoreCheckpoint(tx, sandboxId)) !== JSON.stringify(restore)) deny();
            // The host has already persisted the claim and cancelled cleanup.
            if (acceptedGeneration === undefined) deny();
            const restarted = await transitionSandbox(tx, {
              sandboxId,
              expectedGeneration: acceptedGeneration,
              fromStates: ["stopped"],
              toState: "starting",
              actor: "resume_admission",
              code: "docker_resume_admitted",
              effects: [],
            });
            if (restarted.kind === "conflict") deny();
            await tx.query(
              `with claim as (
                 select c.created_at,c.claimed_at from public.docker_resume_claims c
                  where c.request_id=$2 and c.sandbox_id=$1 and c.accepted and c.created_at is not null
               ), activation as (
                 select max(l.activation) as number from public.sandbox_launch_stages l where l.sandbox_id=$1
               )
               insert into public.sandbox_launch_stages(sandbox_id,activation,stage,at)
               select $1,a.number,t.stage,t.at from claim c cross join activation a
               cross join lateral (values ('accepted',c.created_at),('provider_claimed',c.claimed_at)) t(stage,at)
               where a.number is not null and t.at is not null
               on conflict(sandbox_id,activation,stage) do update set at=least(sandbox_launch_stages.at,excluded.at)`,
              [sandboxId, requestId],
            );
          }
          const ticket = await createRuntimeEnrolments(scoped, key, { allowDockerIssue: true }).issue({
            sandboxId,
            ownerId: actor.userId,
            configuration: projected.configuration,
          });
          descriptor = { serverUrl: url.origin, artifact: projected.artifact, enrolmentToken: ticket.enrolmentToken };
        }
        const hostStore = createDockerHostStore(scoped, key);
        if (machine) {
          const adapter = hostStore.machine({
            actor,
            hostId: current.hostId,
            installationId: current.installationId,
            bootstrapDescriptor: descriptor,
          });
          try {
            await adapter.bootstrap({
              ...machine.target,
              bindingRef: createHash("sha256").update(descriptor.enrolmentToken).digest("hex"),
              signal: machine.context.signal,
            });
          } catch (error) {
            if (!(error instanceof DockerMachinePending) || error.outcome !== "pending") throw error;
          }
          return { requestId, operation: "bootstrap" as const, state: existing?.outcome ?? "pending" };
        }
        await hostStore.enqueueSandbox(actor, sandboxId, {
          requestId,
          operation: resume ? "resume" : "bootstrap",
          bootstrapDescriptor: descriptor,
        });
        if (!handoff) await requireTurnClaim(tx);
        return {
          requestId,
          operation: resume ? ("resume" as const) : ("bootstrap" as const),
          state: existing?.outcome ?? "pending",
        };
      }

      if (handoff && turnClaim) {
        let admitted: Awaited<ReturnType<typeof admit>> | undefined;
        await turnClaim.handoffGeneration({
          lockPrerequisites,
          async advance(tx, job) {
            const { payload } = job;
            if (
              job.sandbox_id !== sandboxId ||
              !payload ||
              typeof payload !== "object" ||
              !("requestId" in payload) ||
              payload.requestId !== requestId
            )
              deny();
            admitted = await admit(tx);
          },
        });
        return admitted ?? deny();
      }
      return await sql.transaction(async (tx) => {
        await lockPrerequisites(tx);
        return admit(tx);
      });
    } catch (error) {
      if (
        error instanceof DockerHostDraining ||
        error instanceof DockerHostFull ||
        error instanceof DockerLimitsRefused ||
        error instanceof DockerRetentionEnded
      )
        throw error;
      return deny();
    }
  }
  return {
    bootstrapMachine: (actor: Actor, target: MachineIdentity, context: JobContext) =>
      bootstrap(actor, target.sandboxId, target.sandboxId, false, undefined, { target, context }),
    bootstrap: (actor: Actor, sandboxId: string, requestId: string) => bootstrap(actor, sandboxId, requestId),
    resume: (actor: Actor, sandboxId: string, requestId: string, claim?: RuntimeTurnClaim) =>
      bootstrap(actor, sandboxId, requestId, true, claim),
  };
}
