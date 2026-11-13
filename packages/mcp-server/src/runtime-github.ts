import { createHash, createHmac } from "node:crypto";
import { readBoundedText } from "@armada/auth";
import {
  decryptSecret,
  encryptSecret,
  type GitHubResolveDeps,
  gitIdentity,
  resolveGitHubAccess,
  type SandboxProviderId,
  type Sql,
  VaultError,
} from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createSqlData } from "./data.ts";
import { matchesDockerLaunchRequestHash } from "./docker-launch-identity.ts";
import { createDockerSandboxService } from "./docker-sandbox-service.ts";
import type { Route } from "./http.ts";
import { createRuntimeAgent } from "./runtime-agent.ts";
import type { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";

const path = "/api/runtime/github/credentials";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const denied = (): never => {
  throw new VaultError("forbidden", "Runtime GitHub access is unavailable.");
};
interface Binding {
  sandboxId: string;
  ownerId: string;
  orgId: string;
  epoch: string;
  githubId: number;
  repositories: { url: string }[];
}
const snapshot = `select jsonb_build_object('sandboxId',s.id,'ownerId',s.owner_id,'orgId',s.org_id,
 'epoch',r.epoch::text,'providerSandboxId',s.provider_sandbox_id,'goldenId',s.golden_id,
 'membershipEpoch',e.epoch,'mcpGeneration',s.mcp_generation,'connectionEpoch',c.connection_epoch,
 'githubId',c.github_id,'repositories',g.config->'repos') as binding,s.expires_at
 from public.sandboxes s join public.runtime_enrolments r on r.sandbox_id=s.id
 left join public.goldens g on g.id=s.golden_id and g.org_id=s.org_id
 join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
 join public.mcp_actor_epochs e on e.org_id=m.org_id and e.user_id=m.user_id
 join public.github_connections c on c.user_id=s.owner_id and c.revoked_at is null
 where s.id=$1 and (s.provider='docker' or (
   ((s.provider='boat' and s.boat_runtime) or (s.provider='modal' and s.runtime_transport='dialout'))
   and g.provider=s.provider and s.harness in ('codex','claude')))
 and (s.status in ('ready','running') or (s.provider='boat' and s.boat_runtime and s.status='starting' and s.activity_lease_id is not null and s.activity_until>now())) and s.stop_requested_at is null and s.deleted_at is null and s.expires_at>now()
 and not exists(select 1 from public.runtime_checkpoints p where p.sandbox_id=s.id and p.epoch=r.epoch)`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function allowed(binding: Pick<Binding, "repositories">, repo: string) {
  return (
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) &&
    binding.repositories?.some(({ url }) => {
      const m =
        /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
          url,
        );
      return m?.[1]?.toLowerCase() === repo.toLowerCase();
    })
  );
}
export type RuntimeGitHub = ReturnType<typeof createRuntimeGitHub>;
/** Separate from the legacy/native broker: no boot-id exec, provider lookup, SSH
 * or changes to host authority. Tokens leave only the reviewed private response. */
export function createRuntimeGitHub(options: {
  sql: Sql;
  key: string;
  origin: string;
  github: GitHubResolveDeps;
  commands: ReturnType<typeof createRuntimeCommands>;
}) {
  const { sql, key } = options,
    authority = createRuntimeEnrolments(sql, key);
  const owner = async (caller: Caller, id: string) => {
    const native = await createSqlData(sql)(caller).sandboxes.get(id);
    const s =
      native ??
      (await createDockerSandboxService(sql, key).get(
        {
          userId: caller.userId,
          orgId:
            (
              await sql.query<{ org_id: string }>(
                "select org_id from public.sandboxes where id=$1 and owner_id=$2 and provider='docker' and org_id=any($3::uuid[])",
                [id, caller.userId, caller.orgs.map((org) => org.orgId)],
              )
            ).rows[0]?.org_id ?? denied(),
        },
        id,
      ));
    if (
      !s ||
      s.ownerId !== caller.userId ||
      !(
        s.provider === "docker" ||
        (((s.provider === "boat" && native?.boatRuntime) ||
          (s.provider === "modal" && native?.runtimeTransport === "dialout")) &&
          (s.harness === "codex" || s.harness === "claude"))
      ) ||
      s.deletedAt
    )
      return denied();
    return s;
  };
  const current = async (tx: Sql, id: string) => {
    const row = (await tx.query<{ binding: Binding; expires_at: string | Date }>(snapshot, [id])).rows[0] ?? denied();
    const docker = (
      await tx.query<{ request_enc: Uint8Array<ArrayBuffer>; request_hash: string; actor_epoch: string }>(
        `select d.request_enc,d.request_hash,d.actor_epoch::text from public.docker_launch_requests d
       join public.sandboxes s on s.id=d.sandbox_id join public.mcp_actor_epochs e on e.org_id=s.org_id and e.user_id=s.owner_id
       where s.id=$1 and s.provider='docker' and d.actor_epoch=e.epoch`,
        [id],
      )
    ).rows[0];
    if (docker) {
      const manifest = JSON.parse(await decryptSecret(docker.request_enc, key));
      if (
        !matchesDockerLaunchRequestHash(manifest.request, docker.request_hash) ||
        !Array.isArray(manifest.request.repos ?? manifest.snapshotConfig?.repos)
      )
        return denied();
      row.binding.repositories = manifest.request.repos ?? manifest.snapshotConfig.repos;
      Object.assign(row.binding, { launchHash: docker.request_hash, launchActorEpoch: docker.actor_epoch });
      // Match the JSONB representation persisted with the capability, including nested key order.
      row.binding =
        (await tx.query<{ binding: Binding }>("select $1::jsonb as binding", [JSON.stringify(row.binding)])).rows[0]
          ?.binding ?? denied();
    }
    if (!Array.isArray(row.binding.repositories)) return denied();
    return row;
  };
  const read = async (tx: Sql, capHash: string) =>
    (
      await tx.query<{
        sandbox_id: string;
        epoch: string;
        revision: string;
        binding: Binding;
        acquisition_count: string;
        delivered_at: string | null;
        last_accessed_at: string | null;
      }>(
        "select sandbox_id,epoch::text,revision::text,binding,acquisition_count::text,delivered_at::text,last_accessed_at::text from public.runtime_github_capabilities where hash=$1 and expires_at>now()",
        [capHash],
      )
    ).rows[0] ?? denied();
  const issued = async (tx: Sql, binding: Binding, value: string) =>
    tx.query(
      `insert into public.github_runtime_issued(sandbox_id,owner_id,physical_generation,hash,token_enc) values($1,$2,$3,$4,$5) on conflict do nothing`,
      [binding.sandboxId, binding.ownerId, `runtime:${binding.epoch}`, hash(value), await encryptSecret(value, key)],
    );
  async function preflightRepositories(caller: Caller, org: string, repositories: { url: string }[]) {
    if (!caller.orgs.some((m) => m.orgId === org) || !options.github.app) return denied();
    const access = await resolveGitHubAccess({ ...options.github, caller: "managed_runtime" }, caller.userId);
    if (access.status !== "connected") return denied();
    for (const { url } of repositories) {
      const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
      if (!match) return denied();
      const response = await (options.github.fetch ?? fetch)(`https://api.github.com/repos/${match[1]}`, {
        redirect: "error",
        headers: { authorization: `Bearer ${access.token}`, accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15000),
      }).catch(() => denied());
      const repository = (await response.json().catch(() => null)) as { full_name?: unknown } | null;
      if (
        !response.ok ||
        typeof repository?.full_name !== "string" ||
        repository.full_name.toLowerCase() !== match[1]?.toLowerCase()
      )
        return denied();
    }
  }
  async function preflight(caller: Caller, input: { org: string; golden: string; repository: string }) {
    if (!caller.orgs.some((m) => m.orgId === input.org) || !options.github.app) return denied();
    const golden = (
      await sql.query<{ provider: SandboxProviderId; snapshot_id: string | null; repositories: { url: string }[] }>(
        `select g.provider::text as provider,g.provider_snapshot_id as snapshot_id,g.config->'repos' as repositories from public.goldens g
      join public.members m on m.org_id=g.org_id and m.user_id=$1 where g.org_id=$2 and g.name=$3 and g.provider in ('boat','modal')
      and (g.visibility='org' or g.owner_id=$1) and g.removed_at is null`,
        [caller.userId, input.org, input.golden],
      )
    ).rows;
    if (golden.length !== 1 || !golden[0]?.snapshot_id || !allowed(golden[0], input.repository)) return denied();
    const access = await resolveGitHubAccess({ ...options.github, caller: "managed_runtime" }, caller.userId);
    if (access.status !== "connected") return denied();
    const response = await (options.github.fetch ?? fetch)(`https://api.github.com/repos/${input.repository}`, {
      method: "GET",
      redirect: "error",
      headers: {
        authorization: `Bearer ${access.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15000),
    }).catch(() => denied());
    const repository: unknown = await response.json().catch(() => null);
    if (
      !response.ok ||
      !repository ||
      typeof repository !== "object" ||
      !("full_name" in repository) ||
      typeof repository.full_name !== "string" ||
      repository.full_name.toLowerCase() !== input.repository.toLowerCase()
    )
      return denied();
    return {
      githubReady: true,
      provider: golden[0].provider,
      repository: input.repository,
      login: access.identity.login,
    };
  }
  async function status(caller: Caller, id: string) {
    const s = await owner(caller, id);
    const empty = {
      id,
      configured: false,
      revision: null as string | null,
      credentialRequests: 0,
      lastAccessedAt: null as string | null,
    };
    try {
      return await authority.withOwner(id, s.ownerId, async (tx, scope) => {
        const now = await current(tx, id);
        const row = (
          await tx.query<{ hash: string }>(
            "select hash from runtime_github_capabilities where sandbox_id=$1 and epoch=$2 and delivered_at is not null and expires_at>now()",
            [id, scope.epoch],
          )
        ).rows[0];
        if (!row) return { ...empty, runtime: { kind: "armada" as const, epoch: scope.epoch } };
        const cap = await read(tx, row.hash);
        if (!same(cap.binding, now.binding))
          return { ...empty, runtime: { kind: "armada" as const, epoch: scope.epoch } };
        return {
          id,
          configured: true,
          runtime: { kind: "armada" as const, epoch: scope.epoch },
          revision: cap.revision,
          credentialRequests: Number(cap.acquisition_count),
          lastAccessedAt: cap.last_accessed_at,
        };
      });
    } catch {
      return empty;
    }
  }
  async function prepare(caller: Caller, id: string, resolved?: Awaited<ReturnType<typeof resolveGitHubAccess>>) {
    const s = await owner(caller, id);
    if (!options.github.app) return denied();
    const before = await authority.withOwner(id, s.ownerId, (tx) => current(tx, id));
    const access = resolved ?? (await resolveGitHubAccess({ ...options.github, caller: "managed_runtime" }, s.ownerId));
    if (access.status !== "connected" || access.identity.id !== before.binding.githubId) return denied();
    const identity = gitIdentity(access.identity);
    const issuedCap = await authority.withOwner(id, s.ownerId, async (tx, scope) => {
      const now = await current(tx, id);
      if (!same(now.binding, before.binding) || now.binding.epoch !== scope.epoch) return denied();
      const revision =
        (await tx.query<{ revision: string }>("select nextval('public.runtime_github_revision_seq')::text as revision"))
          .rows[0]?.revision ?? denied();
      const capability = `armada_gh_${createHmac("sha256", Buffer.from(key, "base64"))
        .update(JSON.stringify(["armada/runtime/github/v1", now.binding, revision]))
        .digest("hex")}`;
      await tx.query(
        `insert into runtime_github_capabilities(sandbox_id,epoch,revision,hash,binding,expires_at) values($1,$2,$3,$4,$5::jsonb,$6)
    on conflict(sandbox_id,epoch) do update set revision=excluded.revision,hash=excluded.hash,binding=excluded.binding,expires_at=excluded.expires_at,delivered_at=null,acquisition_count=0,last_accessed_at=null`,
        [id, scope.epoch, revision, hash(capability), JSON.stringify(now.binding), now.expires_at],
      );
      await issued(tx, now.binding, capability);
      return { revision, capability, epoch: scope.epoch, expiresAt: new Date(now.expires_at).getTime() };
    });
    const history = (
      await sql.query<{ token_enc: Uint8Array<ArrayBuffer> }>(
        "select token_enc from github_runtime_issued where sandbox_id=$1 and owner_id=$2 and physical_generation=$3",
        [id, s.ownerId, `runtime:${issuedCap.epoch}`],
      )
    ).rows;
    const retired = await Promise.all(history.map((row) => decryptSecret(row.token_enc, key)));
    if (!s.model || !s.reasoningEffort) return denied();
    const agent = createRuntimeAgent(options.commands, {
      harness: s.harness,
      ownerId: s.ownerId,
      sandboxId: id,
      providerSandboxId: s.providerSandboxId,
      cwd: s.repositoryDir ? `/home/user/${s.repositoryDir}` : "/home/user",
      defaults: { model: s.model, reasoningEffort: s.reasoningEffort },
    });
    await agent.configureGitHub(
      {
        version: 1,
        revision: issuedCap.revision,
        generation: issuedCap.epoch,
        expiresAt: issuedCap.expiresAt,
        capability: issuedCap.capability,
        url: new URL(path, options.origin).href,
        retired,
        identity: { name: identity.name, email: identity.email },
      },
      `github_${issuedCap.epoch}_${issuedCap.revision}`,
    );
    await authority.withOwner(id, s.ownerId, async (tx, scope) => {
      const now = await current(tx, id),
        cap = await read(tx, hash(issuedCap.capability));
      if (scope.epoch !== issuedCap.epoch || !same(now.binding, cap.binding)) return denied();
      await tx.query("update runtime_github_capabilities set delivered_at=now() where hash=$1", [
        hash(issuedCap.capability),
      ]);
    });
    return {
      id,
      status: "connected" as const,
      login: access.identity.login,
      runtime: { kind: "armada" as const, epoch: issuedCap.epoch },
      revision: issuedCap.revision,
    };
  }
  async function prepareTurn(caller: Caller, id: string) {
    const launch = (
      await sql.query<{ request_enc: Uint8Array<ArrayBuffer> }>(
        `select d.request_enc from public.docker_launch_requests d join public.sandboxes s on s.id=d.sandbox_id
       where s.id=$1 and s.provider='docker' and s.owner_id=$2 and s.org_id=any($3::uuid[])`,
        [id, caller.userId, caller.orgs.map((org) => org.orgId)],
      )
    ).rows[0];
    if (!launch) return;
    const manifest = JSON.parse(await decryptSecret(launch.request_enc, key));
    if (manifest.request?.repos) await prepare(caller, id);
  }
  const route: Route = async (request) => {
    if (new URL(request.url).pathname !== path) return null;
    const headers = { "cache-control": "no-store" };
    try {
      if (request.method !== "POST" || request.headers.has("origin")) return denied();
      const token = request.headers.get("authorization")?.match(/^Bearer (armada_gh_[a-f0-9]{64})$/)?.[1] ?? denied();
      const body = JSON.parse(await readBoundedText(request, 1024)) as {
        version: number;
        repository: string;
        operation: string;
      };
      if (
        Object.keys(body).some((k) => !["version", "repository", "operation"].includes(k)) ||
        body.version !== 1 ||
        typeof body.repository !== "string" ||
        !["gh", "git"].includes(body.operation)
      )
        return denied();
      const grant = await read(sql, hash(token));
      const before = await authority.withOwner(grant.sandbox_id, grant.binding.ownerId, async (tx, scope) => {
        const now = await current(tx, grant.sandbox_id),
          cap = await read(tx, hash(token));
        if (scope.epoch !== cap.epoch || !same(now.binding, cap.binding) || !allowed(cap.binding, body.repository))
          return denied();
        return now;
      });
      const access = await resolveGitHubAccess({ ...options.github, caller: "managed_runtime" }, grant.binding.ownerId);
      if (access.status !== "connected" || access.identity.id !== before.binding.githubId) return denied();
      return await authority.withOwner(grant.sandbox_id, grant.binding.ownerId, async (tx, scope) => {
        const now = await current(tx, grant.sandbox_id),
          cap = await read(tx, hash(token));
        if (
          scope.epoch !== cap.epoch ||
          !same(now.binding, before.binding) ||
          !same(now.binding, cap.binding) ||
          !allowed(cap.binding, body.repository)
        )
          return denied();
        await issued(tx, now.binding, access.token);
        await tx.query(
          "update runtime_github_capabilities set acquisition_count=acquisition_count+1,last_accessed_at=now() where hash=$1",
          [hash(token)],
        );
        return Response.json({ token: access.token }, { headers });
      });
    } catch {
      return new Response(null, { status: 403, headers });
    }
  };
  async function prepareLaunch(caller: Caller, id: string) {
    const s = await owner(caller, id);
    const access = await resolveGitHubAccess({ ...options.github, caller: "managed_runtime" }, s.ownerId);
    if (access.status !== "connected") return { status: access.status, message: access.message };
    const result = await prepare(caller, id, access);
    return {
      status: result.status,
      login: result.login,
      ...(access.expiresAt ? { tokenExpiresAt: access.expiresAt.toISOString() } : {}),
    };
  }
  return { prepare, prepareTurn, prepareLaunch, status, preflight, preflightRepositories, route };
}
