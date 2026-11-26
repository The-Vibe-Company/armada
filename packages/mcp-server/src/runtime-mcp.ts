import { createHash, createHmac, randomUUID } from "node:crypto";
import { type McpConfiguration, validateMcpConfiguration } from "@armada/agent-runtime";
import type { Harness } from "@armada/core";
import { MAX_MCP_CONNECTIONS, parsePinnedMcpStdio } from "@armada/core";
import { sandboxCheckOperations } from "@armada/core/contract";
import {
  createSqlMcpLaunchPort,
  createSqlMcpLeasePort,
  createSqlMcpRegistry,
  decryptSecret,
  resolveLaunchConnections,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { z } from "zod";
import type { Caller } from "./caller.ts";
import { UUID } from "./control-input.ts";
import { runtimeBridgeTarget, usesHostLaunch } from "./provider-runtime-admission.ts";
import type { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import { selfFinishToken } from "./sandbox-finish.ts";

export interface ObservedRuntimeHealth {
  epoch: string;
  ready?: unknown;
  generation?: unknown;
  mcpVersion?: unknown;
  stdioMcpEnv?: unknown;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const deny = (): never => {
  throw new VaultError("forbidden", "Runtime MCP access is unavailable.");
};
const serverName = (id: string) => `armada_${id.replaceAll("-", "_")}`;
const launchConnectionIds = z.array(z.guid()).max(MAX_MCP_CONNECTIONS);
export const pinnedMcpConnections = z
  .array(
    z.object({
      id: z.guid(),
      version: z.number().int().positive(),
      generation: z.number().int().positive(),
    }),
  )
  .max(MAX_MCP_CONNECTIONS);

type ConnectionDefinition = { command: string | null; args: string[] };
function pinnedServer(definition: ConnectionDefinition) {
  try {
    return { type: "stdio" as const, ...parsePinnedMcpStdio(definition.command ?? "", definition.args) };
  } catch {
    throw new VaultError("invalid", "Runtime MCP requires an exact pinned stdio launcher and valid arguments.");
  }
}
const launcherEnvironment =
  /^(?:PATH|HOME|USERPROFILE|PREFIX|DESTDIR|SHELL|ENV|BASH_ENV|BASHOPTS|SHELLOPTS|ZDOTDIR|COREPACK_.+|NODE(?:JS)?_.+|NPM_.+|NPX_.+|UV_.+|UVX_.+|PYTHON.*|PIP_.+|VIRTUAL_ENV.*|CONDA_.+|LD_.+|DYLD_.+|XDG_.+|GIT_.+|(?:ALL|HTTP|HTTPS|NO)_PROXY|SSL_CERT_.+|OPENSSL_.+|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE)$/i;

async function boundStdioServer(
  definition: ConnectionDefinition & { value_enc: Uint8Array<ArrayBuffer> | null },
  key: string,
) {
  const launcher = pinnedServer(definition);
  if (definition.value_enc === null) return launcher;
  let env: Record<string, string>;
  try {
    env = JSON.parse(await decryptSecret(definition.value_enc, key));
    if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error();
  } catch {
    throw new VaultError("invalid", "Runtime MCP could not read the stdio grant environment.");
  }
  if (Object.keys(env).some((name) => launcherEnvironment.test(name)))
    throw new VaultError("invalid", "MCP stdio environment cannot override launcher settings.");
  return { ...launcher, env };
}
function validateConfiguration(configuration: McpConfiguration) {
  try {
    validateMcpConfiguration(configuration);
  } catch {
    throw new VaultError("invalid", "MCP configuration exceeds runtime limits or contains invalid fields.");
  }
}
export type RuntimeMcp = ReturnType<typeof createRuntimeMcp>;
/** Configure pinned local commands and scoped remote gateway access over private epoch-fenced RPC. */
export function createRuntimeMcp(options: {
  sql: Sql;
  key: string;
  origin: string;
  commands: ReturnType<typeof createRuntimeCommands>;
  probe?: (userId: string, orgId: string, connectionId: string) => Promise<{ status: string; toolNames?: string[] }>;
}) {
  const { sql, key } = options,
    authority = createRuntimeEnrolments(sql, key);
  const httpServer = (path: string, token: string) => ({
    type: "http" as const,
    url: new URL(path, options.origin).href,
    headers: { Authorization: `Bearer ${token}` },
  });
  const gatewayServer = (id: string, token: string) => httpServer(`/mcp/gateway/${id}`, token);
  const selfServer = (binding: Parameters<typeof selfFinishToken>[1]) =>
    httpServer("/api/v1/orchestrator-tools/mcp", selfFinishToken(key, binding));
  async function connections(
    db: Sql,
    caller: Pick<Caller, "userId">,
    org: string,
    selected: string[],
    lockForAdmission = false,
  ) {
    const { rows: result } = await db.query<
      ConnectionDefinition & {
        id: string;
        transport: "http" | "sse" | "stdio";
        value_enc: Uint8Array<ArrayBuffer> | null;
        connected: boolean;
        scope: string;
        version: number;
        generation: number;
      }
    >(
      `select c.id,c.transport,c.command,c.args,c.scope,g.version,g.generation,
        case when c.transport='stdio' then g.value_enc end as value_enc,
        not c.disabled and public.mcp_grant_effective_status(g.status,g.revoked_at,g.refresh_consumed,g.refresh_until)='connected' as connected
      from public.mcp_connections c join public.mcp_grants g on g.connection_id=c.id
      join public.members m on m.org_id=c.org_id and m.user_id=$1
      where c.org_id=$2 and c.id=any($3::uuid[]) and (c.scope='org' or c.owner_id=$1)
      order by c.id${lockForAdmission ? " for share of c,g nowait" : ""}`,
      [caller.userId, org, selected],
    );
    if (result.length !== selected.length) throw new VaultError("not_found", "No such MCP connection.");
    if (result.some((c) => !c.connected)) return deny();
    const servers: McpConfiguration["servers"] = {};
    for (const c of result) {
      servers[serverName(c.id)] =
        c.transport === "stdio" ? await boundStdioServer(c, key) : gatewayServer(c.id, `armada_gw_${"a".repeat(43)}`);
    }
    if (result.some((c) => c.transport === "stdio")) {
      // Budget for the full wire configuration, including the largest database epoch and generation.
      const placeholderId = "00000000-0000-0000-0000-000000000000";
      servers.armada_self = selfServer({
        sandboxId: placeholderId,
        ownerId: placeholderId,
        epoch: "9223372036854775807",
        generation: 2147483647,
      });
      validateConfiguration({ revision: "0".repeat(64), servers });
    }
    return result.map(({ id, transport, scope, version, generation }) => ({
      id,
      transport,
      scope,
      version,
      generation,
    }));
  }
  async function preflight(caller: Caller, input: { org: string; connections: unknown; toolInventory?: boolean }) {
    if (!caller.orgs.some((m) => m.orgId === input.org)) return deny();
    const { connections: selection } = sandboxCheckOperations.postSandboxMcpPreflightV1.input.body.shape;
    const parsed = selection.safeParse(input.connections);
    if (!parsed.success) throw new VaultError("invalid", `Select 1–${MAX_MCP_CONNECTIONS} MCP connection UUIDs.`);
    const selected = [...new Set(parsed.data.map((id) => id.toLowerCase()))].sort();
    const definitions = await connections(sql, caller, input.org, selected);
    const inventory: { connectionId: string; tools: string[] }[] = [];
    for (const { id, transport } of definitions) {
      const result = transport === "stdio" ? undefined : await options.probe?.(caller.userId, input.org, id);
      if (result && result.status !== "connected") return deny();
      if (input.toolInventory) {
        if (
          !result?.toolNames ||
          result.toolNames.length > 10000 ||
          result.toolNames.some((name) => typeof name !== "string" || !name || name.length > 512)
        )
          throw new VaultError("unavailable", "Complete MCP tool inventory is unavailable.");
        inventory.push({ connectionId: id, tools: [...result.toolNames] });
      }
    }
    return { mcpReady: true, connections: selected, ...(input.toolInventory ? { mcpToolInventory: inventory } : {}) };
  }
  async function owner(caller: Caller, id: string) {
    if (!UUID.test(id)) return deny();
    const row = (
      await sql.query<{
        id: string;
        orgId: string;
        ownerId: string;
        provider: "boat" | "modal" | "docker";
        harness: Harness;
        boatRuntime: boolean;
        modalTransport: string | null;
      }>(
        `select s.id,s.org_id as "orgId",s.owner_id as "ownerId",s.provider,s.harness,
          s.boat_runtime as "boatRuntime",s.runtime_transport as "modalTransport"
        from public.sandboxes s
        join public.members m on m.org_id=s.org_id and m.user_id=$2
        where s.id=$1 and s.owner_id=$2 and s.org_id=any($3::uuid[])
          and s.deleted_at is null
          and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)`,
        [id, caller.userId, caller.orgs.map((org) => org.orgId)],
      )
    ).rows[0];
    if (
      !row ||
      (!usesHostLaunch(row.provider) &&
        !runtimeBridgeTarget({
          provider: row.provider,
          harness: row.harness,
          boatRuntime: row.boatRuntime,
          ...(row.modalTransport ? { modalTransport: row.modalTransport } : {}),
        }))
    )
      return deny();
    return row;
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
    current?: Awaited<ReturnType<typeof scope>>,
  ) {
    const scoped = current ?? (await scope(db, s.id, epoch));
    // Read a bound definition and its effective grant generation from the same snapshot.
    const definitions = (
      await db.query<{
        id: string;
        generation: number;
        transport: "http" | "sse" | "stdio";
        url: string | null;
        command: string | null;
        args: string[];
        value_enc: Uint8Array<ArrayBuffer> | null;
      }>(
        `select c.id,g.generation,c.transport,c.url,c.command,c.args,
          case when c.transport='stdio' then g.value_enc end as value_enc
        from public.mcp_bindings b join public.mcp_connections c on c.id=b.connection_id
        join public.mcp_grants g on g.id=b.grant_id and g.connection_id=c.id
        join public.members m on m.org_id=c.org_id and m.user_id=$2
        where b.sandbox_id=$1 and c.org_id=$3 and (c.scope='org' or c.owner_id=$2) and not c.disabled
          and public.mcp_grant_effective_status(g.status,g.revoked_at,g.refresh_consumed,g.refresh_until)='connected'
        order by c.id for share of c,g,b`,
        [s.id, caller.userId, s.orgId],
      )
    ).rows;
    if (JSON.stringify(definitions.map((c) => c.id)) !== JSON.stringify(selected)) return deny();
    const servers: McpConfiguration["servers"] = {};
    const gatewayLeases: { connectionId: string; tokenHash: string; generation: number }[] = [];
    for (const c of definitions) {
      const { generation } = c;
      const name = serverName(c.id);
      if (c.transport === "stdio") {
        servers[name] = await boundStdioServer(c, key);
        continue;
      }
      const payload = JSON.stringify([
        "armada/runtime/mcp/v1",
        s.id,
        s.ownerId,
        s.orgId,
        epoch,
        scoped.mcp_generation,
        c.id,
        generation,
        c.url,
        c.transport,
      ]);
      const token = `armada_gw_${createHmac("sha256", Buffer.from(key, "base64")).update(payload).digest("base64url")}`;
      gatewayLeases.push({ connectionId: c.id, tokenHash: hash(token), generation });
      servers[name] = gatewayServer(c.id, token);
    }
    servers.armada_self = selfServer({
      sandboxId: s.id,
      ownerId: s.ownerId,
      epoch,
      generation: scoped.mcp_generation,
    });
    const grants = definitions.map(({ id, generation }) => [id, generation]);
    const revision = createHmac("sha256", Buffer.from(key, "base64"))
      .update(JSON.stringify([epoch, scoped.mcp_generation, grants, servers]))
      .digest("hex");
    const configuration = { revision, servers };
    validateConfiguration(configuration);
    return { configuration, gatewayLeases, expiresAt: new Date(scoped.expires_at) };
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
  /** The command boundary records each runtime outcome (with this acceptance check) under the request ID. */
  const call = async (
    s: Awaited<ReturnType<typeof owner>>,
    request: Parameters<typeof options.commands.call>[1],
    expectedEpoch: string,
    signal: AbortSignal | undefined,
    failure: string,
    accept: (reply: Awaited<ReturnType<typeof options.commands.call>>) => boolean,
    assertClaim?: (tx: Sql) => Promise<void>,
  ) => {
    const reply = await options.commands.call(s.ownerId, request, {
      expectedEpoch,
      accept,
      ...(assertClaim ? { assertClaim } : {}),
      ...(signal ? { signal } : {}),
    });
    if (
      reply.status !== 200 ||
      reply.body.version !== 1 ||
      reply.body.requestId !== request.requestId ||
      !accept(reply)
    )
      throw new VaultError("unavailable", failure);
    return reply;
  };
  async function prepare(
    caller: Caller,
    id: string,
    signal?: AbortSignal,
    assertClaim?: (tx: Sql) => Promise<void>,
    healthRequestId?: string,
    observedHealth?: ObservedRuntimeHealth,
  ) {
    signal?.throwIfAborted();
    const s = await owner(caller, id);
    const initial = await authority.withOwner(s.id, s.ownerId, async (tx, live) => {
      await assertClaim?.(tx);
      const currentScope = await scope(tx, s.id, live.epoch);
      const selection = await selected(tx, s.id);
      const previous = (
        await tx.query<{ physical_generation: string; revision: string; configured: boolean }>(
          "select physical_generation,revision,configured from public.mcp_bootstraps where sandbox_id=$1",
          [s.id],
        )
      ).rows[0];
      const p = await plan(tx, caller, s, live.epoch, selection, currentScope);
      let cached =
        previous?.configured === true &&
        previous.physical_generation === `runtime:${live.epoch}` &&
        previous.revision === p.configuration.revision;
      const leases = createSqlMcpLeasePort(tx);
      for (const { tokenHash } of p.gatewayLeases) if (!(await leases.validate(tokenHash, "tools"))) cached = false;
      return { epoch: live.epoch, selection, cached: cached ? receipt(s, live.epoch, p, selection) : undefined };
    });
    if (!initial || initial.cached) return initial?.cached;
    // Feature evidence is bound to this epoch before any private configuration.
    let features: { stdioMcpEnv?: unknown };
    if (observedHealth && observedHealth.epoch === initial.epoch) {
      if (
        observedHealth.ready !== true ||
        observedHealth.generation !== initial.epoch ||
        observedHealth.mcpVersion !== 1
      )
        throw new VaultError("unavailable", "Runtime MCP v1 requires an updated runtime artifact.");
      features = observedHealth;
    } else {
      const healthCommand = {
        version: 1 as const,
        sandboxId: s.id,
        requestId: healthRequestId ?? randomUUID(),
        op: "health" as const,
      };
      const health = await call(
        s,
        healthCommand,
        initial.epoch,
        signal,
        "Runtime MCP v1 requires an updated runtime artifact.",
        (health) => {
          const evidence = health.body.result as
            | { ready?: unknown; generation?: unknown; mcpVersion?: unknown }
            | undefined;
          return (
            health.epoch === initial.epoch &&
            evidence?.ready === true &&
            evidence.generation === initial.epoch &&
            evidence.mcpVersion === 1
          );
        },
        assertClaim,
      );
      features = health.body.result as { stdioMcpEnv?: unknown };
    }
    const prepareConfiguration = () =>
      authority.withOwner(s.id, s.ownerId, async (tx, live) => {
        if (live.epoch !== initial.epoch) return deny();
        await assertClaim?.(tx);
        const p = await plan(tx, caller, s, live.epoch, initial.selection);
        if (
          features.stdioMcpEnv !== true &&
          Object.values(p.configuration.servers).some((server) => server.type === "stdio" && server.env !== undefined)
        )
          throw new VaultError("unavailable", "Stdio MCP environment requires an updated runtime artifact.");
        const wire = {
          version: 1 as const,
          sandboxId: s.id,
          requestId: `mcp_${live.epoch}_${p.configuration.revision}`,
          op: "configureMcp" as const,
          configuration: p.configuration,
        };
        signal?.throwIfAborted();
        return {
          ...p,
          epoch: live.epoch,
          wire,
          leaseExpiresAt: live.commandGrantExpiresAt ?? p.expiresAt,
        };
      });
    let prepared!: Awaited<ReturnType<typeof prepareConfiguration>>;
    const admittedTxs = new WeakSet<Sql>();
    const admitInEnqueueTx = async (tx: Sql) => {
      await assertClaim?.(tx);
      if (admittedTxs.has(tx)) return;
      admittedTxs.add(tx);
      const enrolled = (
        await tx.query<{ epoch: string }>("select epoch::text from public.runtime_enrolments where sandbox_id=$1", [
          s.id,
        ])
      ).rows[0];
      if (enrolled?.epoch !== prepared.epoch) return deny();
      const p = await plan(tx, caller, s, prepared.epoch, initial.selection);
      if (JSON.stringify(p.configuration) !== JSON.stringify(prepared.configuration)) return deny();
      const leases = createSqlMcpLeasePort(tx);
      for (const { connectionId, tokenHash, generation } of p.gatewayLeases) {
        const existing = (await tx.query("select id from public.mcp_leases where hash=$1", [tokenHash])).rows.length;
        if (!existing)
          await leases.issue({
            sandboxId: s.id,
            connectionId,
            tokenHash,
            operations: ["tools", "resources", "prompts"],
            expiresAt: prepared.leaseExpiresAt,
          });
        const stored = (
          await tx.query<{ generation: number; runtime_epoch: string }>(
            "select generation,runtime_epoch::text from public.mcp_leases where hash=$1",
            [tokenHash],
          )
        ).rows[0];
        if (
          !stored ||
          stored.runtime_epoch !== prepared.epoch ||
          stored.generation !== generation ||
          !(await leases.validate(tokenHash, "tools"))
        )
          return deny();
      }
      await tx.query(
        `insert into public.mcp_bootstraps(sandbox_id,physical_generation,revision,configured) values($1,$2,$3,false)
        on conflict(sandbox_id) do update set physical_generation=excluded.physical_generation,revision=excluded.revision,configured=false`,
        [s.id, `runtime:${prepared.epoch}`, p.configuration.revision],
      );
      signal?.throwIfAborted();
    };
    const reply = await options.commands.callPrepared(
      s.ownerId,
      "configureMcp",
      async () => {
        prepared = await prepareConfiguration();
        return {
          request: prepared.wire,
          options: {
            expectedEpoch: prepared.epoch,
            assertClaim: admitInEnqueueTx,
            ...(signal ? { signal } : {}),
            accept: acknowledgesRevision,
          },
        };
      },
      s.provider,
      s.id,
    );
    function acknowledgesRevision(reply: Awaited<ReturnType<typeof options.commands.call>>) {
      return (reply.body.result as { revision?: unknown } | undefined)?.revision === prepared.configuration.revision;
    }
    if (
      reply.status !== 200 ||
      reply.body.version !== 1 ||
      reply.body.requestId !== prepared.wire.requestId ||
      !acknowledgesRevision(reply)
    )
      throw new VaultError("unavailable", "Runtime MCP configuration was not acknowledged.");
    await authority.withOwner(s.id, s.ownerId, async (tx, live) => {
      await assertClaim?.(tx);
      const p = await plan(tx, caller, s, live.epoch, initial.selection);
      if (live.epoch !== prepared.epoch || JSON.stringify(p.configuration) !== JSON.stringify(prepared.configuration))
        return deny();
      const leases = createSqlMcpLeasePort(tx);
      for (const { tokenHash } of p.gatewayLeases) if (!(await leases.validate(tokenHash, "tools"))) return deny();
      const written = await tx.query(
        "update public.mcp_bootstraps set configured=true where sandbox_id=$1 and physical_generation=$2 and revision=$3 returning sandbox_id",
        [s.id, `runtime:${live.epoch}`, p.configuration.revision],
      );
      if (!written.rows.length) return deny();
      await assertClaim?.(tx);
    });
    return receipt(s, prepared.epoch, prepared, initial.selection);
  }
  const launch = createSqlMcpLaunchPort(sql, createSqlMcpRegistry(sql, key));
  const connectionLifecycle = {
    ...launch,
    async validate(actor: Parameters<typeof launch.validate>[0], selection: string[], visibility: "private" | "org") {
      if (selection.length > MAX_MCP_CONNECTIONS)
        throw new VaultError("invalid", `Select at most ${MAX_MCP_CONNECTIONS} MCP connections.`);
      await launch.validate(actor, selection, visibility);
      await connections(sql, actor, actor.orgId, selection);
    },
    async prepare(
      _provider: unknown,
      sandbox: { id: string },
      actor: { userId: string; orgId: string; role: "admin" | "member" },
      signal?: AbortSignal,
      assertClaim?: (tx: Sql) => Promise<void>,
    ) {
      await prepare(
        { userId: actor.userId, via: "service", orgs: [{ orgId: actor.orgId, role: actor.role }] },
        sandbox.id,
        signal,
        assertClaim,
      );
    },
  };
  async function bindLaunch(
    tx: Sql,
    actor: { userId: string; orgId: string },
    sandboxId: string,
    visibility: "private" | "org",
    selection:
      | { requested: string[] | undefined }
      | { pins: z.infer<typeof pinnedMcpConnections>; orgTemplate: boolean },
  ) {
    const launch = createSqlMcpLaunchPort(tx, createSqlMcpRegistry(tx, key));
    const requested = "pins" in selection ? selection.pins.map(({ id }) => id) : selection.requested;
    const parsed = launchConnectionIds.optional().safeParse(requested);
    if (!parsed.success) throw new VaultError("invalid", `Select at most ${MAX_MCP_CONNECTIONS} MCP connections.`);
    const ids = await resolveLaunchConnections(
      parsed.data?.map((id) => id.toLowerCase()),
      () => launch.defaults(actor, visibility),
      async (ids) => {
        if (ids.length > MAX_MCP_CONNECTIONS)
          throw new VaultError("invalid", `Select at most ${MAX_MCP_CONNECTIONS} MCP connections.`);
        if (!ids.length) return;
        const live = await connections(tx, actor, actor.orgId, ids, true).catch((error: unknown) => {
          const fields = error as { errno?: string; code?: string } | null;
          if ((fields?.errno ?? fields?.code) === "55P03")
            throw new VaultError("conflict", "A selected MCP connection is being updated. Retry the launch.");
          throw error;
        });
        if ("pins" in selection) {
          const byId = new Map(live.map((row) => [row.id, row]));
          for (const pin of selection.pins) {
            const row = byId.get(pin.id.toLowerCase());
            if (
              row?.version !== pin.version ||
              row.generation !== pin.generation ||
              (selection.orgTemplate && row.scope !== "org")
            )
              throw new VaultError("conflict", "A pinned MCP connection changed.");
          }
        }
      },
    );
    await launch.bind(sandboxId, ids);
  }
  return { prepare, preflight, connections: connectionLifecycle, bindLaunch };
}
