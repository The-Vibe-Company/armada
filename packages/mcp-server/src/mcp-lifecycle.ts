import {
  createSqlMcpLaunchPort,
  createSqlMcpLeasePort,
  createSqlMcpRegistry,
  type GoldenActor,
  type LaunchStores,
  type McpRegistry,
  type McpStdioLauncher,
  type Provider,
  parsePinnedMcpStdio,
  type SandboxInfo,
  type SandboxRecord,
  type Sql,
} from "@armada/core/server";
import { bootstrapBoatMcp, type McpBootstrap, normalizeNativeMcpBootstrap } from "./mcp-native.ts";
import { resolveMcpStdioExecutable } from "./mcp-stdio-bootstrap.ts";

/** Server-authorized lease reconciliation; no VM or user receives the signing key. */
export function createMcpLifecycle(options: {
  sql: Sql;
  encryptionKey: string | undefined;
  origin: string;
  registry: McpRegistry;
}) {
  const { sql, registry } = options;
  const sign = async (value: string) => {
    if (!options.encryptionKey) throw Error("MCP lease signing is not configured.");
    const raw = Buffer.from(options.encryptionKey, "base64");
    if (raw.length !== 32) throw Error("Invalid MCP lease signing key.");
    const master = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const derived = await crypto.subtle.sign("HMAC", master, new TextEncoder().encode("armada/mcp/lease-key/v1"));
    const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))).toString("base64url");
  };
  const hash = async (v: string) =>
    Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))).toString("hex");
  async function physicalIdentity(provider: Provider, id: string, physical: SandboxInfo): Promise<string> {
    if (physical.physicalGeneration) {
      if (physical.physicalGeneration.length > 512) throw Error("Invalid provider physical generation.");
      return JSON.stringify([provider.id, id, physical.physicalGeneration]);
    }
    if (provider.id !== "boat")
      throw Error("Provider must expose a trusted physicalGeneration that changes on restore/runtime replacement.");
    const result = await provider.exec({
      sandboxId: id,
      command: "cat /proc/sys/kernel/random/boot_id",
      timeoutSeconds: 30,
    });
    if (result.detached || result.timedOut || result.exitCode !== 0 || !/^[a-f0-9-]{36}$/i.test(result.stdout.trim()))
      throw Error("Cannot identify the physical MCP sandbox generation.");
    return JSON.stringify([provider.id, id, result.stdout.trim()]);
  }
  async function reconcile(
    provider: Provider,
    sandbox: Pick<SandboxRecord, "id" | "providerSandboxId" | "ownerId" | "orgId">,
  ) {
    const selected = await registry.sandboxConnections(sandbox.ownerId, sandbox.orgId, sandbox.id);
    const previous = await sql.query("select sandbox_id from public.mcp_bootstraps where sandbox_id=$1::uuid", [
      sandbox.id,
    ]);
    if (!selected.length && !previous.rows.length) return;
    const physical = await provider.get(sandbox.providerSandboxId);
    if (physical.state !== "ready" && physical.state !== "running")
      throw Error("MCP configuration requires a running physical sandbox.");
    if (!physical.expiresAt || physical.expiresAt.getTime() <= Date.now())
      throw Error("Provider must report a future physical expiry before MCP configuration.");
    const expiresAt = new Date(Math.min(physical.expiresAt.getTime(), Date.now() + 86400000));
    const boot = await physicalIdentity(provider, sandbox.providerSandboxId, physical);
    const launchers = new Map<McpStdioLauncher, string>();
    for (const c of selected)
      if (c.transport === "stdio") {
        const definition = parsePinnedMcpStdio(c.command ?? "", c.args ?? []);
        if (!launchers.has(definition.command))
          launchers.set(
            definition.command,
            await resolveMcpStdioExecutable(provider, sandbox.providerSandboxId, definition.command),
          );
      }
    if (!sql.transaction) throw Error("MCP reconciliation requires transactional SQL.");
    // Commit the physical-generation fence BEFORE configuration I/O. A failed installer must
    // never roll back revocation of credentials recovered from an old machine snapshot.
    await sql.transaction(async (tx) => {
      const locked = await tx.query<{ id: string }>(
        "select id from public.sandboxes where id=$1::uuid and org_id=$2::uuid and owner_id=$3::uuid and provider=$4 and provider_sandbox_id=$5 and status not in ('deleted','failed') for update",
        [sandbox.id, sandbox.orgId, sandbox.ownerId, provider.id, sandbox.providerSandboxId],
      );
      if (!locked.rows.length) throw Error("Sandbox is no longer active.");
      const receipt = (
        await tx.query<{ physical_generation: string }>(
          "select physical_generation from public.mcp_bootstraps where sandbox_id=$1::uuid",
          [sandbox.id],
        )
      ).rows[0];
      if (receipt && receipt.physical_generation !== boot)
        await tx.query("update public.sandboxes set mcp_generation=mcp_generation+1 where id=$1::uuid", [sandbox.id]);
      if (!receipt || receipt.physical_generation !== boot)
        await tx.query(
          `insert into public.mcp_bootstraps(sandbox_id,physical_generation,revision,configured) values($1::uuid,$2,'',false) on conflict(sandbox_id) do update set physical_generation=excluded.physical_generation,revision='',configured=false`,
          [sandbox.id, boot],
        );
    });
    const prepared = await sql.transaction(async (tx) => {
      const locked = await tx.query<{ mcp_generation: number; status: string }>(
        `select mcp_generation,status from public.sandboxes where id=$1::uuid and org_id=$2::uuid and owner_id=$3::uuid and status not in ('deleted','failed') and provider=$4 and provider_sandbox_id=$5 for update`,
        [sandbox.id, sandbox.orgId, sandbox.ownerId, provider.id, sandbox.providerSandboxId],
      );
      const row = locked.rows[0];
      if (!row) throw Error("Sandbox is no longer authorized for MCP configuration.");
      if (row.status === "stopped" || row.status === "starting") {
        const restored = await tx.query(
          `update public.sandboxes s set status='ready',stopped_at=null
          where s.id=$1::uuid and s.mcp_generation=$2 and s.status in ('stopped','starting') and s.deleted_at is null
          and s.org_id=$3::uuid and s.owner_id=$4::uuid
          and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id) returning s.id`,
          [sandbox.id, row.mcp_generation, sandbox.orgId, sandbox.ownerId],
        );
        if (!restored.rows.length) throw Error("Sandbox generation or authorization changed before MCP restore.");
      }
      const current = await tx.query<{ id: string; generation: number }>(
        `select c.id,g.generation from public.mcp_bindings b join public.mcp_connections c on c.id=b.connection_id join public.mcp_grants g on g.id=b.grant_id where b.sandbox_id=$1::uuid order by c.id`,
        [sandbox.id],
      );
      const bindingRevision = await hash(JSON.stringify([sandbox.id, row.mcp_generation, boot, current.rows]));
      const config: McpBootstrap = {
        revision: bindingRevision,
        servers: {},
      };
      const leasePort = createSqlMcpLeasePort(tx);
      const currentDefinitions = await createSqlMcpRegistry(tx, options.encryptionKey).sandboxConnections(
        sandbox.ownerId,
        sandbox.orgId,
        sandbox.id,
      );
      for (const c of currentDefinitions) {
        if (c.status !== "connected") throw Error("An MCP connection needs reconnecting or removal before this turn.");
        const name = `armada_${c.id.replaceAll("-", "_")}`;
        if (c.transport === "stdio") {
          const definition = parsePinnedMcpStdio(c.command ?? "", c.args ?? []);
          const command = launchers.get(definition.command);
          if (!command) throw Error("MCP stdio bindings changed during startup; retry this turn.");
          config.servers[name] = { type: "stdio", command, args: definition.args };
          continue;
        }
        const grant = current.rows.find((g) => g.id === c.id);
        if (!grant) throw Error("MCP binding changed during configuration.");
        const token = `armada_gw_${await sign(JSON.stringify([sandbox.id, row.mcp_generation, boot, c.id, grant.generation]))}`;
        const tokenHash = await hash(token);
        const existing = await tx.query<{ id: string }>("select id from public.mcp_leases where hash=$1", [tokenHash]);
        if (existing.rows.length) {
          await tx.query("update public.mcp_leases set expires_at=$2 where hash=$1 and revoked_at is null", [
            tokenHash,
            expiresAt,
          ]);
          if (!(await leasePort.validate(tokenHash, "tools")))
            throw Error("MCP lease is fenced; reconnect this connection.");
        } else
          await leasePort.issue({
            sandboxId: sandbox.id,
            connectionId: c.id,
            tokenHash,
            operations: ["tools", "resources", "prompts"],
            expiresAt,
          });
        config.servers[name] = {
          type: "http",
          url: `${options.origin}/mcp/gateway/${c.id}`,
          headers: { Authorization: `Bearer ${token}` },
        };
      }
      config.revision = await hash(JSON.stringify([bindingRevision, config.servers]));
      return {
        config,
        bindingRevision,
        generation: row.mcp_generation,
        hashes: await Promise.all(
          Object.values(config.servers)
            .filter((server) => server.type === "http")
            .map((server) => hash(server.type === "http" ? (server.headers?.Authorization?.slice(7) ?? "") : "")),
        ),
      };
    });
    // Serialize installations across replicas without holding authority/lease row locks
    // over SSH/runtime I/O: disable/revoke/stop must still commit immediately.
    await sql.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1,523))", [sandbox.id]);
      const receipt = (
        await tx.query<{ physical_generation: string; revision: string; configured: boolean }>(
          "select * from public.mcp_bootstraps where sandbox_id=$1::uuid",
          [sandbox.id],
        )
      ).rows[0];
      if (receipt?.physical_generation !== boot)
        throw Error("Physical generation changed during MCP configuration; retry the turn.");
      const nativeConfig = normalizeNativeMcpBootstrap(prepared.config);
      if (receipt.revision === prepared.config.revision && receipt.configured) {
        for (const tokenHash of prepared.hashes)
          if (!(await createSqlMcpLeasePort(tx).validate(tokenHash, "tools")))
            throw Error("MCP lease is no longer active.");
        return;
      }
      if (provider.configureMcp) {
        try {
          await provider.configureMcp({ sandboxId: sandbox.providerSandboxId, configuration: nativeConfig });
        } catch {
          throw Error("Native MCP configuration I/O failed; no turn was started.");
        }
      } else if (provider.id === "boat") await bootstrapBoatMcp(provider, sandbox.providerSandboxId, nativeConfig);
      else throw Error("Provider must support authenticated configureMcp before starting a connected sandbox.");
      for (const tokenHash of prepared.hashes)
        if (!(await createSqlMcpLeasePort(tx).validate(tokenHash, "tools")))
          throw Error("MCP authority changed during native configuration.");
      const verified = await createSqlMcpRegistry(tx, options.encryptionKey).sandboxConnections(
        sandbox.ownerId,
        sandbox.orgId,
        sandbox.id,
      );
      if (
        verified.length !== Object.keys(prepared.config.servers).length ||
        verified.some((c) => c.status !== "connected")
      )
        throw Error("MCP authority changed during native configuration.");
      const active = (
        await tx.query<{ mcp_generation: number }>(
          "select mcp_generation from public.sandboxes where id=$1::uuid and status not in ('stopped','deleted','failed')",
          [sandbox.id],
        )
      ).rows[0];
      if (active?.mcp_generation !== prepared.generation)
        throw Error("Sandbox generation changed during MCP configuration.");
      const current = (
        await tx.query<{ id: string; generation: number }>(
          `select c.id,g.generation from public.mcp_bindings b join public.mcp_connections c on c.id=b.connection_id join public.mcp_grants g on g.id=b.grant_id where b.sandbox_id=$1::uuid order by c.id`,
          [sandbox.id],
        )
      ).rows;
      if ((await hash(JSON.stringify([sandbox.id, prepared.generation, boot, current]))) !== prepared.bindingRevision)
        throw Error("MCP bindings changed during native configuration.");
      const written = await tx.query(
        `update public.mcp_bootstraps set revision=$3,configured=true where sandbox_id=$1::uuid and physical_generation=$2 returning sandbox_id`,
        [sandbox.id, boot, prepared.config.revision],
      );
      if (!written.rows.length) throw Error("Physical generation changed during MCP configuration.");
    });
  }
  const launch = createSqlMcpLaunchPort(sql, registry);
  const connections: NonNullable<LaunchStores["connections"]> = {
    ...launch,
    validate: async (actor, ids, visibility) => {
      await launch.validate(actor, ids, visibility);
      for (const id of ids) {
        const c = await registry.get(actor.userId, actor.orgId, id);
        if (c.transport === "stdio") parsePinnedMcpStdio(c.command ?? "", c.args ?? []);
      }
    },
    prepare: async (provider, sandbox, _actor: GoldenActor) => reconcile(provider, sandbox),
  };
  return {
    connections,
    reconcile,
    /** Trusted provider transition only; never callable via a client-supplied resume flag. */
    async beforeResume(provider: Provider, providerSandboxId: string, caller: { userId: string; orgId: string }) {
      if (!sql.transaction) throw Error("MCP resume fencing requires transactional SQL.");
      return sql.transaction(async (tx) => {
        const member = (
          await tx.query<{ user_id: string }>(
            "select user_id from public.members where user_id=$1::uuid and org_id=$2::uuid for share",
            [caller.userId, caller.orgId],
          )
        ).rows[0];
        if (!member) throw Error("No authorized Armada sandbox for this resume.");
        const sandbox = (
          await tx.query<{ id: string }>(
            `select id from public.sandboxes where provider=$1 and provider_sandbox_id=$2 and org_id=$3::uuid
          and (owner_id=$4::uuid or exists(select 1 from public.members a where a.org_id=sandboxes.org_id and a.user_id=$4::uuid and a.role='admin')) and not exists(select 1 from public.orchestrators o where o.sandbox_id=sandboxes.id) and status not in ('deleted','failed') and deleted_at is null for update`,
            [provider.id, providerSandboxId, caller.orgId, caller.userId],
          )
        ).rows[0];
        if (!sandbox) throw Error("No authorized Armada sandbox for this resume.");
        // Serialize a FRESH physical observation with fencing and config publication.
        // A caller's earlier stopped sample can predate another replica's completed
        // resume/configure; it must not fence that replica's newly active leases.
        const physical = await provider.get(providerSandboxId);
        if (["ready", "running", "starting"].includes(physical.state))
          return { sandboxId: sandbox.id, shouldResume: false };
        if (physical.state !== "stopped") throw Error("Sandbox cannot be resumed from its current physical state.");
        // Kernel boot IDs can survive real Boat archive/restore. Commit this fence BEFORE
        // sending resume; only the configured=true winner changes the generation.
        await tx.query(
          `with fenced as (
          update public.mcp_bootstraps b set configured=false where b.sandbox_id=$1::uuid and b.configured
          and exists(select 1 from public.mcp_leases l where l.sandbox_id=b.sandbox_id)
          returning b.sandbox_id)
          update public.sandboxes s set mcp_generation=mcp_generation+1 from fenced b where s.id=b.sandbox_id`,
          [sandbox.id],
        );
        return { sandboxId: sandbox.id, shouldResume: true };
      });
    },
    async beforePrompt(provider: Provider, providerSandboxId: string, caller: { userId: string; orgId: string }) {
      const r = await sql.query<{ id: string; org_id: string; owner_id: string }>(
        `select s.id,s.org_id,s.owner_id from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=$3::uuid where s.provider=$1 and s.provider_sandbox_id=$2 and s.org_id=$4::uuid and (s.owner_id=$3::uuid or m.role='admin') and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)`,
        [provider.id, providerSandboxId, caller.userId, caller.orgId],
      );
      const row = r.rows[0];
      if (!row) throw Error("No authorized Armada sandbox for this native turn.");
      if (row.owner_id !== caller.userId) {
        const personal = await sql.query(
          `select 1 from public.mcp_bindings b join public.mcp_connections c on c.id=b.connection_id
           where b.sandbox_id=$1::uuid and c.scope='personal' limit 1`,
          [row.id],
        );
        if (personal.rows.length) throw Error("Only the sandbox owner can reconcile personal MCP grants.");
      }
      await reconcile(provider, { id: row.id, orgId: row.org_id, ownerId: row.owner_id, providerSandboxId });
      return row.id;
    },
    /** Authorized server renewal for an ongoing VM turn. Never changes native config or tokens. */
    async renewLeases(provider: Provider, sandboxId: string) {
      const row = (
        await sql.query<{ provider_sandbox_id: string; physical_generation: string; mcp_generation: number }>(
          `select s.provider_sandbox_id,b.physical_generation,s.mcp_generation from public.sandboxes s join public.mcp_bootstraps b on b.sandbox_id=s.id
        where s.id=$1::uuid and s.provider=$2 and b.configured and s.status not in ('stopped','deleted','failed')
        and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id)`,
          [sandboxId, provider.id],
        )
      ).rows[0];
      if (!row) return;
      const physical = await provider.get(row.provider_sandbox_id);
      const identity =
        physical.state === "ready" || physical.state === "running"
          ? await physicalIdentity(provider, row.provider_sandbox_id, physical)
          : null;
      if (identity !== row.physical_generation) {
        await sql.query(
          `with invalid as (update public.mcp_bootstraps set configured=false where sandbox_id=$1::uuid and physical_generation=$2 and configured returning sandbox_id)
          update public.sandboxes s set mcp_generation=mcp_generation+1 from invalid b where s.id=b.sandbox_id`,
          [sandboxId, row.physical_generation],
        );
        return;
      }
      if (!physical.expiresAt || physical.expiresAt.getTime() <= Date.now()) return;
      const expiresAt = new Date(Math.min(physical.expiresAt.getTime(), Date.now() + 86400000));
      // Authoritative generation/membership checks are repeated in the UPDATE itself. Renewal
      // cannot revive expired, disabled, revoked or uncertain-refresh credentials.
      await sql.query(
        `update public.mcp_leases l set expires_at=$3
        from public.sandboxes s,public.mcp_connections c,public.mcp_grants g,public.mcp_bootstraps b
        where l.sandbox_id=$1::uuid and s.id=l.sandbox_id and s.mcp_generation=$2 and l.sandbox_generation=s.mcp_generation
        and c.id=l.connection_id and g.id=l.grant_id and l.generation=g.generation
        and b.sandbox_id=s.id and b.physical_generation=$4 and b.configured
        and l.revoked_at is null and l.expires_at>now() and g.revoked_at is null and g.status='connected' and not c.disabled
        and not(g.refresh_consumed and g.refresh_until<=now()) and s.status not in ('stopped','deleted','failed')
        and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id)
        and (c.scope='org' or (s.visibility='private' and c.owner_id=s.owner_id and s.access_owner_id=s.owner_id))`,
        [sandboxId, row.mcp_generation, expiresAt, row.physical_generation],
      );
    },
    async beforeSnapshot(provider: Provider, sandboxId: string) {
      // Persist fencing first. If scrub fails the snapshot is refused, but old credentials
      // still cannot be resurrected; a later turn must reinstall fresh native config.
      await sql.query(
        `with fenced as (
        update public.sandboxes set mcp_generation=mcp_generation+1
        where provider=$1 and provider_sandbox_id=$2 returning id)
        update public.mcp_bootstraps b set configured=false from fenced f where b.sandbox_id=f.id`,
        [provider.id, sandboxId],
      );
      if (provider.id === "boat")
        await bootstrapBoatMcp(provider, sandboxId, { revision: "snapshot_scrub", servers: {} });
      else if (provider.configureMcp) {
        try {
          await provider.configureMcp({ sandboxId, configuration: { revision: "snapshot_scrub", servers: {} } });
        } catch {
          throw Error("Native MCP snapshot scrub I/O failed.");
        }
      } else throw Error("Provider cannot scrub transient MCP configuration before snapshot.");
    },
  };
}
