import { createHash, createHmac } from "node:crypto";
import {
  createSqlMcpLaunchPort,
  createSqlMcpLeasePort,
  createSqlMcpRegistry,
  type Sql,
  VaultError,
} from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createSqlData } from "./data.ts";
import { createRuntimeAgent } from "./runtime-agent.ts";
import type { createRuntimeCommands } from "./runtime-commands.ts";
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
  async function connections(db: Sql, caller: Caller, org: string, selected: string[]) {
    const registry = createSqlMcpRegistry(db, key),
      result = [];
    for (const id of selected) {
      const c = await registry.get(caller.userId, org, id);
      if (c.status !== "connected" || !["http", "sse"].includes(c.transport)) return deny();
      result.push(c);
    }
    return result;
  }
  async function preflight(caller: Caller, input: { org: string; connections: string[] }) {
    if (!caller.orgs.some((m) => m.orgId === input.org)) return deny();
    const selected = ids(input.connections);
    await connections(sql, caller, input.org, selected);
    return { mcpReady: true, connections: selected };
  }
  async function owner(caller: Caller, id: string) {
    const s = await createSqlData(sql)(caller).sandboxes.get(id);
    if (!s || s.ownerId !== caller.userId || s.provider !== "boat" || !s.boatRuntime || s.harness !== "codex")
      return deny();
    return s;
  }
  async function scope(db: Sql, id: string, epoch: string) {
    const row = (
      await db.query<{ mcp_generation: number; expires_at: string | Date }>(
        `select mcp_generation,expires_at from public.sandboxes s
      where s.id=$1 and s.status in ('ready','running') and s.stop_requested_at is null and s.deleted_at is null and s.expires_at>now()
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
  async function refresh(caller: Caller, input: { id: string; connections: string[] }) {
    const s = await owner(caller, input.id),
      selected = ids(input.connections);
    const prepared = await authority.withOwner(s.id, s.ownerId, async (tx, live) => {
      await scope(tx, s.id, live.epoch);
      await connections(tx, caller, s.orgId, selected);
      const bound = (
        await tx.query<{ connection_id: string }>(
          "select connection_id from public.mcp_bindings where sandbox_id=$1 order by connection_id",
          [s.id],
        )
      ).rows.map((r) => r.connection_id);
      if (bound.length && JSON.stringify(bound) !== JSON.stringify(selected))
        throw new VaultError("conflict", "Runtime MCP selection is fixed; use the same connections in this sandbox.");
      if (!bound.length) await createSqlMcpLaunchPort(tx, createSqlMcpRegistry(tx, key)).bind(s.id, selected);
      const p = await plan(tx, caller, s, live.epoch, selected),
        leases = createSqlMcpLeasePort(tx);
      const receipt = (
        await tx.query<{ physical_generation: string; revision: string }>(
          "select physical_generation,revision from public.mcp_bootstraps where sandbox_id=$1",
          [s.id],
        )
      ).rows[0];
      if (receipt?.physical_generation === `runtime:${live.epoch}` && receipt.revision !== p.configuration.revision)
        throw new VaultError(
          "conflict",
          "MCP configuration changed; checkpoint, stop and resume before reconfiguring this runtime.",
        );
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
          stored.generation !== p.grants.find((g) => g.id === connectionId)?.generation
        )
          return deny();
        if (!(await leases.validate(tokenHash, "tools"))) return deny();
      }
      await tx.query(
        `insert into public.mcp_bootstraps(sandbox_id,physical_generation,revision,configured) values($1,$2,$3,false)
        on conflict(sandbox_id) do update set physical_generation=excluded.physical_generation,revision=excluded.revision,configured=false`,
        [s.id, `runtime:${live.epoch}`, p.configuration.revision],
      );
      return { ...p, epoch: live.epoch };
    });
    if (!s.model || !s.reasoningEffort) return deny();
    const agent = createRuntimeAgent(options.commands, {
      ownerId: s.ownerId,
      sandboxId: s.id,
      providerSandboxId: s.providerSandboxId,
      cwd: s.repositoryDir ? `/home/user/${s.repositoryDir}` : "/home/user",
      defaults: { model: s.model, reasoningEffort: s.reasoningEffort },
    });
    await agent.configureMcp(
      prepared.configuration,
      `mcp_${prepared.epoch}_${prepared.configuration.revision}`,
      prepared.epoch,
    );
    await authority.withOwner(s.id, s.ownerId, async (tx, live) => {
      const p = await plan(tx, caller, s, live.epoch, selected);
      if (live.epoch !== prepared.epoch || JSON.stringify(p.configuration) !== JSON.stringify(prepared.configuration))
        return deny();
      for (const server of Object.values(p.configuration.servers))
        if (!(await createSqlMcpLeasePort(tx).validate(hash(server.headers.Authorization.slice(7)), "tools")))
          return deny();
      const receipt = await tx.query(
        "update public.mcp_bootstraps set configured=true where sandbox_id=$1 and physical_generation=$2 and revision=$3 returning sandbox_id",
        [s.id, `runtime:${live.epoch}`, p.configuration.revision],
      );
      if (!receipt.rows.length) return deny();
    });
    return {
      id: s.id,
      runtime: { kind: "armada" as const, epoch: prepared.epoch },
      revision: prepared.configuration.revision,
      connections: selected,
      servers: Object.keys(prepared.configuration.servers),
    };
  }
  return { refresh, preflight };
}
