import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Harness } from "@armada/core";
import {
  createSqlMcpLaunchPort,
  createSqlMcpLeasePort,
  createSqlMcpRegistry,
  type Sql,
  VaultError,
} from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createSqlData } from "./data.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const deny = (): never => {
  throw new VaultError("forbidden", "Runtime MCP access is unavailable.");
};
export type RuntimeMcp = ReturnType<typeof createRuntimeMcp>;
/** Remote MCP only: existing registry/grants/gateway policy, private epoch-fenced RPC.
 * No provider lookup, boot ID, SSH, native files or upstream grant material. */
export function createRuntimeMcp(options: {
  sql: Sql;
  key: string;
  origin: string;
  commands: ReturnType<typeof createRuntimeCommands>;
  probe?: (userId: string, orgId: string, connectionId: string) => Promise<{ status: string }>;
}) {
  const { sql, key } = options,
    authority = createRuntimeEnrolments(sql, key);
  const ids = (values: string[]) => {
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.length > 32 ||
      values.some((v) => typeof v !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v))
    )
      throw new VaultError("invalid", "Select 1–32 MCP connection UUIDs.");
    return [...new Set(values.map((v) => v.toLowerCase()))].sort();
  };
  async function connections(db: Sql, caller: Pick<Caller, "userId">, org: string, selected: string[]) {
    const registry = createSqlMcpRegistry(db, key),
      result = [];
    for (const id of selected) {
      const c = await registry.get(caller.userId, org, id);
      if (!["http", "sse"].includes(c.transport))
        throw new VaultError("invalid", "Enrolled runtimes do not support pinned stdio MCP; no native fallback.");
      if (c.status !== "connected") return deny();
      result.push(c);
    }
    return result;
  }
  async function preflight(caller: Caller, input: { org: string; connections: string[] }) {
    if (!caller.orgs.some((m) => m.orgId === input.org)) return deny();
    const selected = ids(input.connections);
    await connections(sql, caller, input.org, selected);
    for (const id of selected)
      if (options.probe && (await options.probe(caller.userId, input.org, id)).status !== "connected") return deny();
    return { mcpReady: true, connections: selected };
  }
  async function owner(caller: Caller, id: string) {
    const docker = (
      await sql.query<{ id: string; orgId: string; ownerId: string; harness: Harness }>(
        `select s.id,s.org_id as "orgId",s.owner_id as "ownerId",s.harness from public.sandboxes s
       join public.members m on m.org_id=s.org_id and m.user_id=$2
       where s.id=$1 and s.provider='docker' and s.owner_id=$2 and s.org_id=any($3::uuid[])`,
        [id, caller.userId, caller.orgs.map((org) => org.orgId)],
      )
    ).rows[0];
    if (docker) return docker;
    const s = await createSqlData(sql)(caller).sandboxes.get(id);
    if (
      !s ||
      s.ownerId !== caller.userId ||
      !((s.provider === "boat" && s.boatRuntime) || (s.provider === "modal" && s.runtimeTransport === "dialout")) ||
      (s.harness !== "codex" && s.harness !== "claude")
    )
      return deny();
    return s;
  }
  async function scope(db: Sql, id: string, epoch: string) {
    const row = (
      await db.query<{ mcp_generation: number; expires_at: string | Date }>(
        `select mcp_generation,expires_at from public.sandboxes s
      where s.id=$1 and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id) and (s.status in ('ready','running') or (s.provider='docker' and s.status='starting') or (s.status='starting' and s.activity_lease_id is not null and s.activity_until>now())) and s.stop_requested_at is null and s.deleted_at is null and s.expires_at>now()
      and not exists(select 1 from public.runtime_checkpoints p where p.sandbox_id=s.id and p.epoch=$2)`,
        [id, epoch],
      )
    ).rows[0];
    return row ?? deny();
  }
  async function plan(
    db: Sql,
    caller: Caller,
    s: Awaited<ReturnType<typeof owner>>,
    epoch: string,
    selected: string[],
  ) {
    const current = await scope(db, s.id, epoch);
    const defs = await connections(db, caller, s.orgId, selected);
    const grants = (
      await db.query<{ id: string; generation: number }>(
        `select c.id,g.generation from public.mcp_bindings b join public.mcp_connections c on c.id=b.connection_id join public.mcp_grants g on g.id=b.grant_id where b.sandbox_id=$1 order by c.id`,
        [s.id],
      )
    ).rows;
    if (JSON.stringify(grants.map((c) => c.id)) !== JSON.stringify(selected)) return deny();
    const servers: Record<string, { type: "http"; url: string; headers: { Authorization: string } }> = {};
    for (const c of defs) {
      const generation = grants.find((g) => g.id === c.id)?.generation ?? deny();
      const payload = JSON.stringify([
        "armada/runtime/mcp/v1",
        s.id,
        s.ownerId,
        s.orgId,
        epoch,
        current.mcp_generation,
        c.id,
        generation,
        c.url,
        c.transport,
      ]);
      const token = `armada_gw_${createHmac("sha256", Buffer.from(key, "base64")).update(payload).digest("base64url")}`;
      servers[`armada_${c.id.replaceAll("-", "_")}`] = {
        type: "http",
        url: new URL(`/mcp/gateway/${c.id}`, options.origin).href,
        headers: { Authorization: `Bearer ${token}` },
      };
    }
    const configuration = { revision: hash(JSON.stringify([epoch, current.mcp_generation, servers])), servers };
    return { configuration, grants, expiresAt: new Date(current.expires_at) };
  }
  const selected = async (db: Sql, id: string) =>
    (
      await db.query<{ connection_id: string }>(
        "select connection_id from public.mcp_bindings where sandbox_id=$1 order by connection_id",
        [id],
      )
    ).rows.map((r) => r.connection_id);
  const receipt = (
    s: Awaited<ReturnType<typeof owner>>,
    epoch: string,
    p: Awaited<ReturnType<typeof plan>>,
    selection: string[],
  ) => ({
    id: s.id,
    runtime: { kind: "armada" as const, epoch },
    revision: p.configuration.revision,
    connections: selection,
    servers: Object.keys(p.configuration.servers),
  });
  async function prepare(caller: Caller, id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const s = await owner(caller, id);
    const initial = await authority.withOwner(s.id, s.ownerId, async (tx, live) => {
      await scope(tx, s.id, live.epoch);
      const selection = await selected(tx, s.id);
      const previous = (
        await tx.query<{ physical_generation: string; revision: string; configured: boolean }>(
          "select physical_generation,revision,configured from public.mcp_bootstraps where sandbox_id=$1",
          [s.id],
        )
      ).rows[0];
      // Untouched model-only workers do not need a new guest capability or RPC.
      if (!selection.length && !previous) return undefined;
      const p = await plan(tx, caller, s, live.epoch, selection);
      let cached =
        previous?.configured === true &&
        previous.physical_generation === `runtime:${live.epoch}` &&
        previous.revision === p.configuration.revision;
      for (const server of Object.values(p.configuration.servers))
        if (!(await createSqlMcpLeasePort(tx).validate(hash(server.headers.Authorization.slice(7)), "tools")))
          cached = false;
      return { epoch: live.epoch, selection, cached: cached ? receipt(s, live.epoch, p, selection) : undefined };
    });
    if (!initial || initial.cached) return initial?.cached;
    // Feature evidence is bound to this epoch before any private configuration.
    const healthCommand = { version: 1 as const, sandboxId: s.id, requestId: randomUUID(), op: "health" as const };
    const health = await options.commands.call(s.ownerId, healthCommand, {
      expectedEpoch: initial.epoch,
      ...(signal ? { signal } : {}),
    });
    const evidence = health.body.result as { ready?: unknown; generation?: unknown; mcpVersion?: unknown } | undefined;
    if (
      health.status !== 200 ||
      health.body.version !== 1 ||
      health.body.requestId !== healthCommand.requestId ||
      health.epoch !== initial.epoch ||
      evidence?.ready !== true ||
      evidence.generation !== initial.epoch ||
      evidence.mcpVersion !== 1
    )
      throw new VaultError("unavailable", "Runtime MCP v1 requires an updated runtime artifact.");
    const prepared = await authority.withOwner(s.id, s.ownerId, async (tx, live) => {
      if (live.epoch !== initial.epoch) return deny();
      const p = await plan(tx, caller, s, live.epoch, initial.selection),
        leases = createSqlMcpLeasePort(tx);
      for (const [name, server] of Object.entries(p.configuration.servers)) {
        const tokenHash = hash(server.headers.Authorization.slice(7)),
          connectionId = name.slice(7).replaceAll("_", "-");
        const existing = (await tx.query("select id from public.mcp_leases where hash=$1", [tokenHash])).rows.length;
        if (!existing)
          await leases.issue({
            sandboxId: s.id,
            connectionId,
            tokenHash,
            operations: ["tools", "resources", "prompts"],
            expiresAt: p.expiresAt,
          });
        const stored = (
          await tx.query<{ generation: number; runtime_epoch: string }>(
            "select generation,runtime_epoch::text from public.mcp_leases where hash=$1",
            [tokenHash],
          )
        ).rows[0];
        if (
          !stored ||
          stored.runtime_epoch !== live.epoch ||
          stored.generation !== p.grants.find((g) => g.id === connectionId)?.generation ||
          !(await leases.validate(tokenHash, "tools"))
        )
          return deny();
      }
      await tx.query(
        `insert into public.mcp_bootstraps(sandbox_id,physical_generation,revision,configured) values($1,$2,$3,false)
        on conflict(sandbox_id) do update set physical_generation=excluded.physical_generation,revision=excluded.revision,configured=false`,
        [s.id, `runtime:${live.epoch}`, p.configuration.revision],
      );
      const wire = {
        version: 1 as const,
        sandboxId: s.id,
        requestId: `mcp_${live.epoch}_${p.configuration.revision}`,
        op: "configureMcp" as const,
        configuration: p.configuration,
      };
      // Serialize preparation AND enqueue, not network waits. Concurrent updated
      // grants can never queue an older snapshot behind a newer configuration.
      const local: Sql = { query: tx.query.bind(tx), transaction: async (work) => work(local) };
      signal?.throwIfAborted();
      await createRuntimeCommands(createRuntimeEnrolments(local, key), key).enqueue(s.ownerId, wire, live.epoch);
      return { ...p, epoch: live.epoch, wire };
    });
    const acknowledged = await options.commands.call(s.ownerId, prepared.wire, {
      expectedEpoch: prepared.epoch,
      ...(signal ? { signal } : {}),
    });
    if (
      acknowledged.status !== 200 ||
      acknowledged.body.version !== 1 ||
      acknowledged.body.requestId !== prepared.wire.requestId ||
      (acknowledged.body.result as { revision?: unknown } | undefined)?.revision !== prepared.configuration.revision
    )
      throw new VaultError("unavailable", "Runtime MCP configuration was not acknowledged.");
    await authority.withOwner(s.id, s.ownerId, async (tx, live) => {
      const p = await plan(tx, caller, s, live.epoch, initial.selection);
      if (live.epoch !== prepared.epoch || JSON.stringify(p.configuration) !== JSON.stringify(prepared.configuration))
        return deny();
      for (const server of Object.values(p.configuration.servers))
        if (!(await createSqlMcpLeasePort(tx).validate(hash(server.headers.Authorization.slice(7)), "tools")))
          return deny();
      const written = await tx.query(
        "update public.mcp_bootstraps set configured=true where sandbox_id=$1 and physical_generation=$2 and revision=$3 returning sandbox_id",
        [s.id, `runtime:${live.epoch}`, p.configuration.revision],
      );
      if (!written.rows.length) return deny();
    });
    return receipt(s, prepared.epoch, prepared, initial.selection);
  }
  const launch = createSqlMcpLaunchPort(sql, createSqlMcpRegistry(sql, key));
  const connectionLifecycle = {
    ...launch,
    async validate(actor: Parameters<typeof launch.validate>[0], selection: string[], visibility: "private" | "org") {
      if (selection.length > 32) throw new VaultError("invalid", "Select at most 32 remote MCP connections.");
      await launch.validate(actor, selection, visibility);
      await connections(sql, actor, actor.orgId, selection);
    },
    async prepare(
      _provider: unknown,
      sandbox: { id: string },
      actor: { userId: string; orgId: string; role: "admin" | "member" },
      signal?: AbortSignal,
    ) {
      await prepare(
        { userId: actor.userId, via: "service", orgs: [{ orgId: actor.orgId, role: actor.role }] },
        sandbox.id,
        signal,
      );
    },
  };
  return { prepare, preflight, connections: connectionLifecycle };
}
