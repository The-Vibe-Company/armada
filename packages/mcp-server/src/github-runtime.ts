import { createHash, createHmac } from "node:crypto";
import {
  decryptSecret,
  encryptSecret,
  type GitHubResolveDeps,
  type Provider,
  resolveGitHubAccess,
  type Sql,
} from "@armada/core/server";

const PATH = "/api/internal/github/credentials";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const denied = (): never => {
  throw Error("github_runtime_denied");
};
interface Identity {
  sandboxId: string;
  ownerId: string;
  orgId: string;
  provider: string;
  providerSandboxId: string;
  mcpGeneration: number;
  githubId: number;
  repositories: { url: string }[];
}
interface Snapshot {
  identity: Identity;
  lifecycle: string;
  expires_at: string | Date;
}
interface Binding {
  identity: Identity;
  physical: string;
  backend: string;
  githubApp: string;
}

// SQL is authoritative independently of any caller/interior policy. Activity's lifecycle counter
// is sampled per issuance; the stable revocation epoch is mcp_generation, NOT that activity counter.
const SELECT = `select jsonb_build_object(
 'sandboxId',s.id,'ownerId',s.owner_id,'orgId',s.org_id,'provider',s.provider,
 'providerSandboxId',s.provider_sandbox_id,'mcpGeneration',s.mcp_generation,
 'goldenId',s.golden_id,'visibility',s.visibility,'accessOwnerId',s.access_owner_id,
 'workspace',g.modal_workspace,'environment',g.modal_environment,'appId',g.modal_app_id,
 'membershipEpoch',e.epoch,'connectionEpoch',c.connection_epoch,'githubId',c.github_id,'repositories',g.config->'repos') as identity,
 s.lifecycle_generation::text as lifecycle,s.expires_at
 from public.sandboxes s join public.goldens g on g.id=s.golden_id
 join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
 join public.mcp_actor_epochs e on e.org_id=m.org_id and e.user_id=m.user_id
 join public.github_connections c on c.user_id=s.owner_id
 where s.id=$1::uuid and s.provider=g.provider and s.org_id=g.org_id and s.provider_sandbox_id is not null
 and s.status in ('starting','ready','running') and s.deleted_at is null
 and s.stop_requested_at is null and s.expires_at>now() and c.revoked_at is null`;

export function createGitHubRuntime(options: {
  sql: Sql;
  github: GitHubResolveDeps;
  origin: string;
  providerForSandbox(id: string): Promise<Provider>;
}) {
  async function snapshot(id: string): Promise<Snapshot> {
    const row = (await options.sql.query<Snapshot>(SELECT, [id])).rows[0];
    return row ?? denied();
  }
  async function physical(
    provider: Provider,
    identity: Identity,
  ): Promise<{ physical: string; backend: string; expires: number }> {
    if (provider.id !== identity.provider || !provider.backendIdentity) return denied();
    const [info, backend] = await Promise.all([provider.get(identity.providerSandboxId), provider.backendIdentity()]);
    if (
      !["ready", "running"].includes(info.state) ||
      info.id !== identity.providerSandboxId ||
      !info.expiresAt ||
      info.expiresAt.getTime() <= Date.now()
    )
      return denied();
    let generation = info.physicalGeneration;
    if (!generation && provider.id === "boat") {
      const result = await provider.exec({
        sandboxId: identity.providerSandboxId,
        command: "cat /proc/sys/kernel/random/boot_id",
        timeoutSeconds: 30,
      });
      if (result.detached || result.timedOut || result.exitCode !== 0 || !/^[a-f0-9-]{36}$/i.test(result.stdout.trim()))
        return denied();
      generation = result.stdout.trim();
    }
    if (!generation || !backend.id) return denied();
    return { physical: generation, backend: backend.id, expires: info.expiresAt.getTime() };
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  function allowed(identity: Identity, repository: string): boolean {
    return (
      Array.isArray(identity.repositories) &&
      identity.repositories.some(({ url }) => {
        if (typeof url !== "string") return false;
        const match =
          /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
            url,
          );
        return match?.[1]?.toLowerCase() === repository.toLowerCase();
      })
    );
  }
  return {
    async prepare(provider: Provider, id: string): Promise<void> {
      if (!options.sql.transaction) return denied();
      if (!options.github.app) return;
      const before = await snapshot(id).catch(() => null);
      if (!before) return;
      if (!provider.configureGitHub) throw Error("github_runtime_unsupported");
      const native = await physical(provider, before.identity);
      const binding: Binding = {
        identity: before.identity,
        physical: native.physical,
        backend: native.backend,
        githubApp: options.github.app.clientId,
      };
      // SQL enforces the CURRENT logical deadline per request; do not freeze an activity deadline
      // into a VM capability and strand a legitimately extended same-VM turn.
      const expiresAt = native.expires;
      const signing = Buffer.from(options.github.encryptionKey ?? "", "base64");
      if (signing.length !== 32) return denied();
      const purpose = createHmac("sha256", signing).update("armada/github/runtime/v1").digest();
      const capability = `armada_gh_${createHmac("sha256", purpose).update(JSON.stringify(binding)).digest("hex")}`;
      const sealedCapability = await encryptSecret(capability, options.github.encryptionKey);
      if (!options.sql.transaction) return denied();
      let revision = "";
      await options.sql.transaction(async (tx) => {
        // Lock the stored identity, not a caller-supplied owner/provider redirect.
        await tx.query("select id from public.sandboxes where id=$1::uuid for update", [id]);
        const current = (await tx.query<Snapshot>(SELECT, [id])).rows[0];
        if (!current || !same(current.identity, before.identity) || current.lifecycle !== before.lifecycle)
          return denied();
        const inserted = await tx.query<{ revision: string }>(
          "insert into public.github_runtime_capabilities(hash,sandbox_id,binding,expires_at) values($1,$2::uuid,$3::jsonb,$4::timestamptz) on conflict(hash) do update set revision=nextval('public.github_runtime_capabilities_revision_seq'),expires_at=excluded.expires_at returning revision::text",
          [digest(capability), id, JSON.stringify(binding), new Date(expiresAt).toISOString()],
        );
        revision = inserted.rows[0]?.revision ?? denied();
        await tx.query(
          `insert into public.github_runtime_issued(sandbox_id,owner_id,physical_generation,hash,token_enc)
          values($1::uuid,$2::uuid,$3,$4,$5::bytea) on conflict do nothing`,
          [id, before.identity.ownerId, native.physical, digest(capability), sealedCapability],
        );
      });
      const history = await options.sql.query<{ token_enc: Uint8Array }>(
        "select token_enc from public.github_runtime_issued where sandbox_id=$1::uuid and owner_id=$2::uuid and physical_generation=$3",
        [id, before.identity.ownerId, native.physical],
      );
      const retired = await Promise.all(
        history.rows.map((row) => decryptSecret(new Uint8Array(row.token_enc), options.github.encryptionKey)),
      );
      const still = await snapshot(id);
      if (!same(still.identity, before.identity) || still.lifecycle !== before.lifecycle) return denied();
      const result = await provider.configureGitHub({
        sandboxId: before.identity.providerSandboxId,
        configuration: {
          version: 1,
          revision,
          retired,
          generation: native.physical,
          url: new URL(PATH, options.origin).href,
          capability,
          expiresAt,
        },
      });
      if (!result.acknowledged) return denied();
    },
    async route(request: Request): Promise<Response | null> {
      if (new URL(request.url).pathname !== PATH) return null;
      try {
        if (request.method !== "POST" || request.headers.has("origin")) return denied();
        const bearer = request.headers.get("authorization") ?? "";
        if (!/^Bearer armada_gh_[a-f0-9]{64}$/.test(bearer)) return denied();
        const hash = digest(bearer.slice(7));
        const read = async () =>
          (
            await options.sql.query<{ sandbox_id: string; binding: Binding }>(
              `select sandbox_id,binding from public.github_runtime_capabilities where hash=$1 and expires_at>now()`,
              [hash],
            )
          ).rows[0] ?? denied();
        const grant = await read();
        if (grant.binding.githubApp !== options.github.app?.clientId) return denied();
        // No owner, organization, provider, backend or generation is accepted from the guest.
        const raw = await request.text();
        if (raw.length > 1024) return denied();
        const body = JSON.parse(raw) as { version: number; repository: string; operation: string };
        if (
          Object.keys(body).some((k) => !["version", "repository", "operation"].includes(k)) ||
          body.version !== 1 ||
          !["gh", "git"].includes(body.operation) ||
          typeof body.repository !== "string" ||
          !allowed(grant.binding.identity, body.repository)
        )
          return denied();
        const before = await snapshot(grant.sandbox_id);
        if (!same(before.identity, grant.binding.identity)) return denied();
        const provider = await options.providerForSandbox(grant.sandbox_id);
        const native = await physical(provider, before.identity);
        if (native.physical !== grant.binding.physical || native.backend !== grant.binding.backend) return denied();
        const access = await resolveGitHubAccess(options.github, before.identity.ownerId);
        if (access.status !== "connected" || access.identity.id !== before.identity.githubId) return denied();
        const [after, still, nativeAfter] = await Promise.all([
          snapshot(grant.sandbox_id),
          read(),
          physical(provider, before.identity),
        ]);
        if (
          !same(before.identity, after.identity) ||
          before.lifecycle !== after.lifecycle ||
          !same(still.binding, grant.binding) ||
          nativeAfter.physical !== native.physical ||
          nativeAfter.backend !== native.backend
        )
          return denied();
        const sealed = await encryptSecret(access.token, options.github.encryptionKey);
        await options.sql.query(
          `insert into public.github_runtime_issued(sandbox_id,owner_id,physical_generation,hash,token_enc)
          values($1::uuid,$2::uuid,$3,$4,$5::bytea) on conflict do nothing`,
          [grant.sandbox_id, before.identity.ownerId, native.physical, digest(access.token), sealed],
        );
        const final = await snapshot(grant.sandbox_id),
          capability = await read();
        if (
          !same(final.identity, before.identity) ||
          final.lifecycle !== before.lifecycle ||
          !same(capability.binding, grant.binding)
        )
          return denied();
        // Only this reviewed private response contains access material; no receipts/events/diagnostics.
        return Response.json({ token: access.token }, { headers: { "cache-control": "no-store" } });
      } catch {
        return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
      }
    },
  };
}
