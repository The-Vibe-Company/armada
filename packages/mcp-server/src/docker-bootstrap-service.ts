import { createHash } from "node:crypto";
import type { GoldenActor, LaunchCredentialResolver, Sql } from "@armada/core";
import { HARNESS_KINDS } from "@armada/core";
import type { MachineIdentity } from "@armada/core/server";
import { decryptSecret } from "@armada/core/server";
import { requirePublishedRuntimeArchitecture } from "../../agent-runtime/src/publication.ts";
import { type BootstrapDescriptor, dockerMachineJobId, parseDockerHostJob } from "../../core/src/docker-host-job.ts";
import { DockerHostDraining, DockerHostFull, DockerLimitsRefused } from "./docker-capacity.ts";
import { createDockerHostStore } from "./docker-host-store.ts";
import { DockerMachinePending } from "./docker-machine-adapter.ts";
import { dockerRuntimeConfiguration } from "./docker-runtime-configuration.ts";
import { createDockerSandboxService } from "./docker-sandbox-service.ts";
import type { JobContext } from "./jobs/runner.ts";
import type { RuntimeConfigurationInput } from "./runtime-configuration.ts";
import { createRuntimeEnrolments, scopedRuntimeSql } from "./runtime-enrolment.ts";

type Actor = { userId: string; orgId: string };
type Stored = {
  request_id: string;
  input_enc: Uint8Array<ArrayBuffer>;
  outcome: "completed" | "failed" | null;
};
type Options = {
  serverUrl: string;
  manifest: unknown;
  architecture: "x64" | "arm64";
  credentials: Pick<LaunchCredentialResolver, "resolve" | "admit">;
  modelAuth?: RuntimeConfigurationInput["modelAuth"];
};
class DockerBootstrapDenied extends Error {
  constructor() {
    super("Docker bootstrap denied");
    this.name = "DockerBootstrapDenied";
  }
}
function deny(): never {
  throw new DockerBootstrapDenied();
}
export function createDockerBootstrapService(sql: Sql, key: string, options: Options) {
  requirePublishedRuntimeArchitecture(options.architecture);
  // Freeze trusted launch inputs across asynchronous credential admission.
  const manifest = structuredClone(options.manifest);
  const serverUrl = options.serverUrl;
  const architecture = options.architecture;
  async function phase(tx: Sql, sandboxId: string, requestId: string) {
    return (
      await tx.query<Stored>(
        `select request_id,input_enc,outcome from public.docker_host_jobs
         where bound_sandbox_id=$1 and bound_operation='bootstrap' and request_id=$2::uuid order by position limit 1`,
        [sandboxId, requestId],
      )
    ).rows[0];
  }
  async function bootstrapMachine(actor: Actor, target: MachineIdentity, context: JobContext) {
    const { sandboxId } = target;
    try {
      if (!sql.transaction) deny();
      // This read must precede resolution: an admin may diagnose, but not bootstrap, an owner's sandbox.
      const snapshot = await createDockerSandboxService(sql).get(actor, sandboxId);
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
      const requestId = dockerMachineJobId(snapshot.generation, "bootstrap");
      const known = await phase(sql, sandboxId, requestId);
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
        const credentials = await options.credentials.resolve(
          launchActor,
          snapshot.harness,
          snapshot.credentialId,
          snapshot.credentialVersion,
        );
        await options.credentials.admit?.(launchActor, credentials, sandboxId);
        projected = await dockerRuntimeConfiguration({
          actor: launchActor,
          sandbox: snapshot,
          credentials,
          manifest,
          architecture,
          ...(options.modelAuth ? { modelAuth: options.modelAuth } : {}),
        });
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

      async function admit(tx: Sql) {
        const scoped = scopedRuntimeSql(tx);
        async function requireStableSandbox() {
          const current = await createDockerSandboxService(scoped).get(actor, sandboxId);
          const enrolledDuringReplay = known && snapshot.status === "starting" && current.status === "ready";
          const expected = enrolledDuringReplay ? { ...snapshot, status: "ready" } : snapshot;
          if (JSON.stringify(current) !== JSON.stringify(expected)) deny();
          return current;
        }
        await tx.query("select id from public.sandboxes where id=$1 for update", [sandboxId]);
        const current = await requireStableSandbox();
        if (!(await context.canDispatch(tx)) || current.stopRequestedAt !== null) deny();
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
        const existing = await phase(tx, sandboxId, requestId);
        let descriptor: BootstrapDescriptor;
        if (existing) {
          if (existing.request_id !== requestId) deny();
          // Only decrypt after current owner/member/host admission; the bound store then
          // revalidates epoch, physical identity and every immutable canonical job byte.
          const envelope = JSON.parse(await decryptSecret(existing.input_enc, key));
          if (!envelope || Object.keys(envelope).sort().join() !== "bound,job" || envelope.bound !== 1) deny();
          const job = parseDockerHostJob({ ...envelope.job, requestId });
          if (job.operation !== "bootstrap") deny();
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
          if (occupied.rows.length) deny();
          const ticket = await createRuntimeEnrolments(scoped, key, { allowDockerIssue: true }).issue({
            sandboxId,
            ownerId: actor.userId,
            configuration: projected.configuration,
          });
          descriptor = { serverUrl: url.origin, artifact: projected.artifact, enrolmentToken: ticket.enrolmentToken };
        }
        const hostStore = createDockerHostStore(scoped, key);
        const adapter = hostStore.machine({
          actor,
          hostId: current.hostId,
          installationId: current.installationId,
          bootstrapDescriptor: descriptor,
        });
        try {
          await adapter.bootstrap({
            ...target,
            bindingRef: createHash("sha256").update(descriptor.enrolmentToken).digest("hex"),
            signal: context.signal,
          });
        } catch (error) {
          if (!(error instanceof DockerMachinePending) || error.outcome !== "pending") throw error;
        }
        return { requestId, operation: "bootstrap" as const, state: existing?.outcome ?? "pending" };
      }

      return await sql.transaction(async (tx) => {
        await lockPrerequisites(tx);
        return admit(tx);
      });
    } catch (error) {
      if (
        error instanceof DockerHostDraining ||
        error instanceof DockerHostFull ||
        error instanceof DockerLimitsRefused
      )
        throw error;
      return deny();
    }
  }
  async function prepareResume(actor: Actor, sandboxId: string) {
    const snapshot = await createDockerSandboxService(sql).get(actor, sandboxId);
    if (snapshot.ownerId !== actor.userId) deny();
    const {
      rows: [member],
    } = await sql.query<{ role: GoldenActor["role"] }>(
      "select role from public.members where org_id=$1 and user_id=$2",
      [actor.orgId, actor.userId],
    );
    if (!member) deny();
    const launchActor = { ...actor, role: member.role };
    const credentials = await options.credentials.resolve(
      launchActor,
      snapshot.harness,
      snapshot.credentialId,
      snapshot.credentialVersion,
    );
    const descriptor = await dockerRuntimeConfiguration({
      actor: launchActor,
      sandbox: snapshot,
      credentials,
      manifest,
      architecture,
      ...(options.modelAuth ? { modelAuth: options.modelAuth } : {}),
    });
    return { ...descriptor, serverUrl };
  }

  return { prepareResume, bootstrapMachine };
}
