import type { GoldenActor, LaunchCredentialResolver, Sql } from "@armada/core";
import { decryptSecret } from "@armada/core/server";
import { requirePublishedRuntimeArchitecture } from "../../agent-runtime/src/publication.ts";
import { type BootstrapDescriptor, parseDockerHostJob } from "../../core/src/docker-host-job.ts";
import { createDockerHostStore } from "./docker-host-store.ts";
import { dockerRuntimeConfiguration } from "./docker-runtime-configuration.ts";
import { createDockerSandboxService } from "./docker-sandbox-service.ts";
import type { RuntimeConfigurationInput } from "./runtime-configuration.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";

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
const scopedSql = (tx: Sql): Sql => ({ query: tx.query.bind(tx), transaction: (work) => work(tx) });

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
        `select request_id,input_enc,outcome from public.docker_host_jobs
         where bound_sandbox_id=$1 and (bound_operation='bootstrap' and $2::uuid is null or bound_operation='resume' and request_id=$2)`,
        [sandboxId, requestId ?? null],
      )
    ).rows[0];
  }
  async function bootstrap(actor: Actor, sandboxId: string, requestId: string, resume = false) {
    try {
      if (options.enabled !== true || !uuid.test(requestId) || !sql.transaction) deny();
      // This read must precede resolution: an admin may diagnose, but not bootstrap, an owner's sandbox.
      const snapshot = await createDockerSandboxService(sql, key).get(actor, sandboxId);
      if (snapshot.ownerId !== actor.userId) deny();
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
      const known = await phase(sql, sandboxId, resume ? requestId : undefined);
      if (!known) {
        const acknowledged = await sql.query(
          `select 1 from public.docker_host_jobs where bound_sandbox_id=$1 and bound_operation='create'
             and bound_actor_id=$2 and outcome='completed'`,
          [sandboxId, actor.userId],
        );
        if (!acknowledged.rows.length) deny();
      }
      let projected: Awaited<ReturnType<typeof dockerRuntimeConfiguration>> | undefined;
      if (!known) {
        if (resume && (snapshot.status !== "stopped" || snapshot.deletedAt !== null)) deny();
        const credentials = await options.credentials.resolve(
          launchActor,
          "codex",
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
      }
      return await sql.transaction(async (tx) => {
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
            `select id from public.credentials where id=$1 and version=$2 and kind in ('openai','codex_auth')
               and status='active' and (expires_at is null or expires_at>now())
               and ((scope='user' and owner_id=$3) or (scope='org' and owner_id=$4)) for share`,
            [snapshot.credentialId, snapshot.credentialVersion, actor.userId, actor.orgId],
          );
          if (!credential.rows.length) deny();
        }
        const host = await tx.query(
          `select id from public.docker_hosts where id=$1 and org_id=$2 and owner_id=$3 and installation_id=$4
             and hash is not null and registration_hash is null and revoked_at is null for update`,
          [snapshot.hostId, actor.orgId, hint.issuer_id, snapshot.installationId],
        );
        if (!host.rows.length) deny();
        await tx.query(`select id from public.sandboxes where id=$1 for update`, [sandboxId]);
        const scoped = scopedSql(tx);
        const current = await createDockerSandboxService(scoped, key).get(actor, sandboxId);
        if (JSON.stringify(current) !== JSON.stringify(snapshot)) deny();
        const original = await tx.query(
          `select 1 from public.docker_host_jobs j join public.mcp_actor_epochs e
             on e.org_id=$3 and e.user_id=$2 and e.epoch=j.bound_actor_epoch
             where j.bound_sandbox_id=$1 and j.bound_operation='create' and j.bound_actor_id=$2
             and j.host_id=$4 and j.outcome='completed'`,
          [sandboxId, actor.userId, actor.orgId, current.hostId],
        );
        if (!original.rows.length) deny();
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
            const restarted = await tx.query(
              `update public.sandboxes set status='starting',status_reason=null,stop_requested_at=null,stopped_at=null,
                 lifecycle_generation=lifecycle_generation+1
                 where id=$1 and status='stopped' and deleted_at is null and expires_at>now() returning id`,
              [sandboxId],
            );
            if (!restarted.rows.length) deny();
          }
          const ticket = await createRuntimeEnrolments(scoped, key, { allowDockerIssue: true }).issue({
            sandboxId,
            ownerId: actor.userId,
            configuration: projected.configuration,
          });
          descriptor = { serverUrl: url.origin, artifact: projected.artifact, enrolmentToken: ticket.enrolmentToken };
        }
        await createDockerHostStore(scoped, key).enqueueSandbox(actor, sandboxId, {
          requestId,
          operation: resume ? "resume" : "bootstrap",
          bootstrapDescriptor: descriptor,
        });
        return {
          requestId,
          operation: resume ? ("resume" as const) : ("bootstrap" as const),
          state: existing?.outcome ?? "pending",
        };
      });
    } catch {
      return deny();
    }
  }
  return {
    bootstrap: (actor: Actor, sandboxId: string, requestId: string) => bootstrap(actor, sandboxId, requestId),
    resume: (actor: Actor, sandboxId: string, requestId: string) => bootstrap(actor, sandboxId, requestId, true),
  };
}
