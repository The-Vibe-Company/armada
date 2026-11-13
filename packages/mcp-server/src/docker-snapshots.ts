import { createHash, randomUUID } from "node:crypto";
import { normalizeGitHubGoldenConfig, officialSandboxImage, parseGoldenConfig, VERSION } from "@armada/core";
import {
  type GitHubInstallationApp,
  type GitHubResolveDeps,
  goldenGitHubAdapter,
  resolveGitHubAccess,
  type Sql,
  VaultError,
} from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createDockerHostStore } from "./docker-host-store.ts";
import { SNAPSHOT_COLUMNS, type SnapshotRow, snapshotRecord } from "./docker-snapshot-data.ts";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const invalid = () => new VaultError("invalid", "Invalid snapshot request.");
export function createDockerSnapshots(
  sql: Sql,
  key: string,
  options: { enabled: boolean; github: GitHubResolveDeps; installationApp: GitHubInstallationApp | null },
) {
  async function command(caller: Caller, operation: string, body: Record<string, unknown>) {
    const org = body.org;
    if (typeof org !== "string" || !uuid.test(org) || !caller.orgs.some((m) => m.orgId === org)) throw invalid();
    const membership = (
      await sql.query<{ role: "admin" | "member" }>("select role from public.members where org_id=$1 and user_id=$2", [
        org,
        caller.userId,
      ])
    ).rows[0];
    if (!membership) throw new VaultError("forbidden", "Snapshot access denied.");
    const actor = { orgId: org, userId: caller.userId };
    const read = async (id?: string) =>
      (
        await sql.query<SnapshotRow>(
          `select ${SNAPSHOT_COLUMNS} from public.docker_snapshots s join public.docker_hosts h on h.id=s.host_id and h.org_id=s.org_id
      where s.org_id=$1 and (s.visibility='org' or s.owner_id=$2) and ($3::uuid is null or s.id=$3) order by s.created_at desc`,
          [org, caller.userId, id ?? null],
        )
      ).rows;
    if (operation === "list") {
      if (Object.keys(body).some((k) => !["org"].includes(k))) throw invalid();
      return { snapshots: (await read()).map(snapshotRecord) };
    }
    if (operation === "get") {
      if (
        Object.keys(body).some((k) => !["org", "id"].includes(k)) ||
        typeof body.id !== "string" ||
        !uuid.test(body.id)
      )
        throw invalid();
      const row = (await read(body.id))[0];
      if (!row) throw new VaultError("not_found", "Snapshot not found.");
      return { snapshot: snapshotRecord(row) };
    }
    if (operation === "create" && options.enabled !== true)
      throw new VaultError("unavailable", "Docker snapshot building is disabled.");
    if (
      operation !== "create" ||
      Object.keys(body).some((k) => !["org", "hostId", "requestId", "name", "visibility", "config"].includes(k))
    )
      throw invalid();
    if (
      typeof body.hostId !== "string" ||
      !uuid.test(body.hostId) ||
      typeof body.requestId !== "string" ||
      !uuid.test(body.requestId) ||
      typeof body.name !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(body.name) ||
      (body.visibility !== undefined && body.visibility !== "private" && body.visibility !== "org")
    )
      throw invalid();
    const visibility = body.visibility ?? "private";
    if (visibility === "org" && membership.role !== "admin")
      throw new VaultError("forbidden", "Only an administrator can publish an organization snapshot.");
    const config = parseGoldenConfig(body.config),
      id = body.requestId,
      hostId = body.hostId,
      name = body.name;
    const digest = createHash("sha256").update(JSON.stringify({ org, hostId, name, visibility, config })).digest("hex");
    const known = (await read(id))[0];
    if (known) {
      if (known.owner_id !== caller.userId || known.request_hash !== digest)
        throw new VaultError("conflict", "Snapshot request changed.");
      return { snapshot: snapshotRecord(known) };
    }
    const baseImage = officialSandboxImage();
    const target = (
      await sql.query(
        "select h.id from public.docker_hosts h join public.members m on m.org_id=h.org_id and m.user_id=h.owner_id where h.id=$1 and h.org_id=$2 and h.hash is not null and h.registration_hash is null and h.revoked_at is null and h.draining_at is null",
        [hostId, org],
      )
    ).rows[0];
    if (!target) throw new VaultError("not_found", "Host unavailable.");
    const authorizer = goldenGitHubAdapter({
      app: options.installationApp,
      ...(options.github.fetch ? { fetch: options.github.fetch } : {}),
      accessToken: async () => {
        const access = await resolveGitHubAccess(
          { ...options.github, caller: "golden_create", minimumLifetimeMs: 3600000 },
          caller.userId,
        );
        if (access.status !== "connected")
          throw new VaultError("forbidden", "Connect GitHub before building a snapshot.");
        return access.token;
      },
    });
    const normalized = normalizeGitHubGoldenConfig(config);
    const authorized = await authorizer.authorize(
      { ...actor, role: membership.role },
      visibility,
      normalized.repos.map((r) => `${r.owner}/${r.repo}`),
    );
    let token = authorized.token;
    const installations = new Set(authorized.repos.map((r) => r.installationId));
    if (authorizer.mint && installations.size === 1 && authorized.repos[0]?.installationId)
      token = (
        await authorizer.mint(
          authorized.repos[0].installationId,
          authorized.repos.map((r) => r.id),
        )
      ).token;
    if (!sql.transaction) throw new VaultError("unavailable", "Snapshot admission unavailable.");
    await sql.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`docker-snapshot:${id}`]);
      const hint = (
        await tx.query<{ owner_id: string }>("select owner_id from public.docker_hosts where id=$1 and org_id=$2", [
          hostId,
          org,
        ])
      ).rows[0];
      if (!hint) throw new VaultError("not_found", "Host not found.");
      const members = await tx.query<{ user_id: string; role: string }>(
        "select user_id,role from public.members where org_id=$1 and user_id in ($2,$3) order by user_id for update",
        [org, caller.userId, hint.owner_id],
      );
      if (
        !members.rows.some((m) => m.user_id === hint.owner_id) ||
        !members.rows.some((m) => m.user_id === caller.userId && (visibility === "private" || m.role === "admin"))
      )
        throw new VaultError("forbidden", "Snapshot admission denied.");
      const host = (
        await tx.query<{ installation_id: string }>(
          "select installation_id from public.docker_hosts where id=$1 and org_id=$2 and owner_id=$3 and hash is not null and revoked_at is null and draining_at is null for update",
          [hostId, org, hint.owner_id],
        )
      ).rows[0];
      if (!host) throw new VaultError("not_found", "Host unavailable.");
      const previous = (await tx.query<SnapshotRow>("select * from public.docker_snapshots where id=$1", [id])).rows[0];
      if (previous) {
        if (previous.owner_id !== caller.userId || previous.org_id !== org || previous.request_hash !== digest)
          throw new VaultError("conflict", "Snapshot request changed.");
        return;
      }
      if (
        (
          await tx.query(
            "select id from public.docker_snapshots where host_id=$1 and status='building' and build_expires_at>now() limit 1",
            [hostId],
          )
        ).rows.length
      )
        throw new VaultError("conflict", "This host is already building a snapshot. Retry after that build finishes.");
      const epochs = (
        await tx.query<{ actor: string; issuer: string }>(
          "select a.epoch::text as actor,i.epoch::text as issuer from public.mcp_actor_epochs a join public.mcp_actor_epochs i on i.org_id=a.org_id and i.user_id=$3 where a.org_id=$1 and a.user_id=$2",
          [org, caller.userId, hint.owner_id],
        )
      ).rows[0];
      if (!epochs) throw new VaultError("forbidden", "Snapshot authority unavailable.");
      const generation = randomUUID(),
        end = Date.now() + 3600000;
      await tx.query(
        `insert into public.docker_snapshots(id,org_id,owner_id,host_id,installation_id,name,visibility,config,request_hash,actor_epoch,issuer_epoch,generation,base_image,build_expires_at,built_on_version)
        values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id,
          org,
          caller.userId,
          hostId,
          host.installation_id,
          name,
          visibility,
          JSON.stringify(config),
          digest,
          epochs.actor,
          epochs.issuer,
          generation,
          baseImage,
          new Date(end),
          VERSION,
        ],
      );
      const local: Sql = { query: tx.query.bind(tx), transaction: (work) => work(tx) };
      await createDockerHostStore(local, key).enqueueSnapshot(actor, hostId, {
        requestId: id,
        operation: "buildSnapshot",
        request: { sandboxId: id, generation, image: baseImage, ttlSeconds: 3600, expiresAt: end },
        build: { id, ownerId: caller.userId, visibility, config, token, armadaVersion: VERSION },
      });
    });
    const row = (await read(id))[0];
    if (!row) throw new VaultError("unavailable", "Snapshot outcome unknown; retry the same request ID.");
    return { snapshot: snapshotRecord(row) };
  }
  return { command };
}
export type DockerSnapshots = ReturnType<typeof createDockerSnapshots>;
