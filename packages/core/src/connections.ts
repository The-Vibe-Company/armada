import { decryptSecret, encryptSecret } from "./crypto.ts";
import type { Sql } from "./golden-store.ts";
import { MCP_CATALOG, type McpCatalogId } from "./mcp-catalog.ts";
import { mcpLaunchSelection } from "./mcp-launch-selection.ts";
import { McpStdioError, parsePinnedMcpStdio } from "./mcp-stdio.ts";
import { canAccessSandboxInterior } from "./sandbox-access.ts";
import { VaultError } from "./vault-error.ts";

export interface McpConnectionDto {
  id: string;
  catalogId?: McpCatalogId | null;
  defaultForLaunch?: boolean;
  name: string;
  orgId: string;
  scope: "personal" | "org";
  transport: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  authType: "auto" | "none" | "bearer" | "headers" | "oauth";
  status: "connected" | "not_connected" | "needs_reconnect" | "unavailable" | "disabled";
  accountLabel?: string;
  toolCount?: number;
  resourceCount?: number;
  promptCount?: number;
  lastError?: string;
}
export interface McpConnectionInput {
  serviceId?: McpCatalogId;
  name: string;
  scope: McpConnectionDto["scope"];
  transport: McpConnectionDto["transport"];
  url?: string;
  command?: string;
  args?: string[];
  authType?: McpConnectionDto["authType"];
  /** Write-only authentication payload. */
  authentication?: string;
}
/** OAuth worker owns issuer discovery, URL validation and fixed callback policy. Never return tokens. */
export interface McpBrokerPort {
  callback?(
    actorId: string,
    state: string,
    code: string,
    issuer?: string,
  ): Promise<{ orgId: string; connectionId: string; status: McpConnectionDto["status"] }>;
  connect(input: {
    userId: string;
    orgId: string;
    connectionId: string;
  }): Promise<{ status: McpConnectionDto["status"]; authorizationUrl?: string }>;
  status(input: {
    userId: string;
    orgId: string;
    connectionId: string;
  }): Promise<{ status: McpConnectionDto["status"] }>;
}
export interface McpRegistry {
  catalog(): Promise<
    Array<(typeof MCP_CATALOG)[number] & { availability: "available" | "setup_required"; setupMessage?: string }>
  >;
  list(userId: string, orgId: string): Promise<McpConnectionDto[]>;
  get(userId: string, orgId: string, id: string): Promise<McpConnectionDto>;
  save(userId: string, orgId: string, input: McpConnectionInput, id?: string): Promise<McpConnectionDto>;
  metadata(
    userId: string,
    orgId: string,
    id: string,
    input: { name?: string; defaultForLaunch?: boolean },
  ): Promise<McpConnectionDto>;
  configureStdio(userId: string, orgId: string, id: string): Promise<McpConnectionDto>;
  setEnabled(userId: string, orgId: string, id: string, enabled: boolean): Promise<McpConnectionDto>;
  sandboxConnections(userId: string, orgId: string, sandboxId: string): Promise<McpConnectionDto[]>;
  revoke(userId: string, orgId: string, id: string, remove?: boolean): Promise<void>;
}
type Row = {
  catalog_id: McpCatalogId | null;
  default_for_launch: boolean;
  id: string;
  org_id: string;
  name: string;
  scope: McpConnectionDto["scope"];
  transport: McpConnectionDto["transport"];
  url: string | null;
  command: string | null;
  args: string[];
  auth_type: McpConnectionDto["authType"];
  status: McpConnectionDto["status"];
  disabled: boolean;
};
const columns =
  "c.catalog_id,c.default_for_launch,c.id,c.org_id,c.name,c.scope,c.transport,c.url,c.command,c.args,c.auth_type,c.disabled,public.mcp_grant_effective_status(g.status,g.revoked_at,g.refresh_consumed,g.refresh_until) as status";
function dto(r: Row): McpConnectionDto {
  return {
    catalogId: r.catalog_id,
    defaultForLaunch: r.default_for_launch,
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    scope: r.scope,
    transport: r.transport,
    ...(r.url ? { url: r.url } : {}),
    ...(r.command ? { command: r.command, args: r.args } : {}),
    authType: r.auth_type,
    status: r.disabled ? "disabled" : r.status,
  };
}
export function createSqlMcpRegistry(
  sql: Sql,
  encryptionKey: string | undefined,
  options: {
    /** Trusted server-only resolver; never populated from request input. */
    catalogAuthentication?: (serviceId: McpCatalogId) => Promise<string | undefined>;
  } = {},
): McpRegistry {
  async function member(user: string, org: string, admin = false) {
    const result = await sql.query<{ role: string }>(
      "select role from public.members where user_id=$1::uuid and org_id=$2::uuid",
      [user, org],
    );
    if (!result.rows[0] || (admin && result.rows[0].role !== "admin"))
      throw new VaultError("forbidden", "Organization membership or administrator permission required.");
  }
  async function get(user: string, org: string, id: string, write = false) {
    await member(user, org);
    const result = await sql.query<Row>(
      `select ${columns} from public.mcp_connections c join public.mcp_grants g on g.connection_id=c.id where c.id=$3::uuid and c.org_id=$2::uuid and (c.scope='org' or c.owner_id=$1::uuid)`,
      [user, org, id],
    );
    const row = result.rows[0];
    if (!row) throw new VaultError("not_found", "No such MCP connection.");
    if (write && row.scope === "org") await member(user, org, true);
    return row;
  }
  return {
    async catalog() {
      const slack = await options.catalogAuthentication?.("slack");
      return MCP_CATALOG.map((service) => ({
        ...service,
        availability: service.id !== "slack" || slack ? "available" : "setup_required",
        ...(service.id === "slack" && !slack
          ? { setupMessage: "Registered confidential OAuth client required; not configured on this deployment." }
          : {}),
      }));
    },
    async list(user, org) {
      await member(user, org);
      const r = await sql.query<Row>(
        `select ${columns} from public.mcp_connections c join public.mcp_grants g on g.connection_id=c.id where c.org_id=$2::uuid and (c.scope='org' or c.owner_id=$1::uuid) order by c.name,c.id`,
        [user, org],
      );
      return r.rows.map(dto);
    },
    async get(user, org, id) {
      return dto(await get(user, org, id));
    },
    async save(user, org, input, id) {
      if (id) {
        const old = await get(user, org, id, true);
        if (old.catalog_id && input.serviceId !== old.catalog_id)
          throw new VaultError("invalid", "Catalog service identity is immutable.");
      }
      if (input.serviceId !== undefined) {
        const service = MCP_CATALOG.find((s) => s.id === input.serviceId);
        if (!service) throw new VaultError("invalid", "Unknown MCP service.");
        const registration = service.id === "slack" ? await options.catalogAuthentication?.("slack") : undefined;
        if (service.id === "slack" && !registration)
          throw new VaultError(
            "unavailable",
            "Slack requires a registered confidential OAuth client; deployment setup required.",
          );
        input = {
          name: input.name,
          scope: input.scope,
          serviceId: service.id,
          ...(registration ? { authentication: registration } : {}),
          transport: "http",
          url: service.url,
          authType: "oauth",
        };
      }
      input = { ...input, authType: input.authType ?? (input.transport === "stdio" ? "none" : "auto") };
      await member(user, org, input.scope === "org");
      if (id) {
        const old = await get(user, org, id, true);
        if (old.scope !== input.scope)
          throw new VaultError(
            "invalid",
            "Connection scope is immutable; create an explicit shared connection instead.",
          );
      }
      validateInput(input);
      const enc = input.authentication === undefined ? null : await encryptSecret(input.authentication, encryptionKey);
      const connectionId = id ?? crypto.randomUUID();
      // One statement: changing a definition invalidates every old lease via grant generation.
      await sql.query(
        `with saved as (
        insert into public.mcp_connections(id,org_id,owner_id,scope,name,transport,url,command,args,auth_type,catalog_id)
        values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::jsonb,$10,$13)
        on conflict(id) do update set name=excluded.name,transport=excluded.transport,url=excluded.url,
        command=excluded.command,args=excluded.args,auth_type=excluded.auth_type,catalog_id=excluded.catalog_id returning id)
        insert into public.mcp_grants(connection_id,value_enc,status) select id,$11::bytea,$12 from saved
        on conflict(connection_id) do update set value_enc=excluded.value_enc,status=excluded.status,
        generation=mcp_grants.generation+1,version=mcp_grants.version+1,revoked_at=null,
        refresh_owner=null,refresh_until=null,refresh_consumed=false`,
        [
          connectionId,
          org,
          user,
          input.scope,
          input.name,
          input.transport,
          input.url ?? null,
          input.command ?? null,
          JSON.stringify(input.args ?? []),
          input.authType,
          enc,
          input.transport === "stdio" ? "connected" : "not_connected",
          input.serviceId ?? null,
        ],
      );
      return dto(await get(user, org, connectionId));
    },
    async metadata(user, org, id, input) {
      await get(user, org, id, true);
      if (
        (input.name !== undefined &&
          (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200)) ||
        (input.defaultForLaunch !== undefined && typeof input.defaultForLaunch !== "boolean")
      )
        throw new VaultError("invalid", "Invalid MCP metadata.");
      const updated = await sql.query<{ id: string }>(
        `update public.mcp_connections c
        set name=coalesce($2,c.name),default_for_launch=coalesce($3,c.default_for_launch)
        where c.id=$1::uuid and c.org_id=$4::uuid
        and exists(select 1 from public.members m where m.org_id=c.org_id and m.user_id=$5::uuid
          and ((c.scope='personal' and c.owner_id=$5::uuid) or (c.scope='org' and m.role='admin')))
        returning c.id`,
        [id, input.name ?? null, input.defaultForLaunch ?? null, org, user],
      );
      if (!updated.rows[0])
        throw new VaultError("forbidden", "MCP metadata permission changed; reload before retrying.");
      return dto(await get(user, org, id));
    },
    async configureStdio(user, org, id) {
      const row = await get(user, org, id, true);
      if (row.disabled) throw new VaultError("conflict", "Enable this MCP connection before configuring.");
      if (row.transport !== "stdio") throw new VaultError("invalid", "This is not a local stdio definition.");
      validateInput({
        name: row.name,
        scope: row.scope,
        transport: row.transport,
        command: row.command ?? "",
        args: row.args,
        authType: row.auth_type,
      });
      const result = await sql.query<{ id: string }>(
        `update public.mcp_grants g set status='connected',generation=generation+1,
        version=version+1,value_enc=null,revoked_at=null,refresh_consumed=false,refresh_owner=null,refresh_until=null
        from public.mcp_connections c where c.id=$1::uuid and g.connection_id=c.id
        and c.transport='stdio' and c.auth_type='none' and not c.disabled returning g.id`,
        [id],
      );
      if (!result.rows[0]) throw new VaultError("conflict", "The stdio definition changed; reload before configuring.");
      return dto(await get(user, org, id));
    },
    async setEnabled(user, org, id, enabled) {
      if (typeof enabled !== "boolean") throw new VaultError("invalid", "enabled must be a boolean.");
      await get(user, org, id, true);
      // An actual transition always destroys old authentication. Reenable requires fresh verification.
      await sql.query(
        `with changed as (
        update public.mcp_connections set disabled=not $2::boolean
        where id=$1::uuid and disabled is distinct from not $2::boolean returning id)
        update public.mcp_grants g set generation=generation+1,version=version+1,
          value_enc=null,status='not_connected',revoked_at=now(),refresh_owner=null,refresh_until=null
        from changed c where g.connection_id=c.id`,
        [id, enabled],
      );
      return dto(await get(user, org, id));
    },
    async sandboxConnections(user, org, sandboxId) {
      await member(user, org);
      const visible = await sql.query<{ id: string; owner_id: string; role: "admin" | "member" }>(
        `select s.id,s.owner_id,m.role from public.sandboxes s
        join public.members m on m.org_id=s.org_id and m.user_id=$3::uuid
        where s.id=$1::uuid and s.org_id=$2::uuid
        and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)`,
        [sandboxId, org, user],
      );
      const sandbox = visible.rows[0];
      if (
        !sandbox ||
        !canAccessSandboxInterior({ ownerId: sandbox.owner_id }, { userId: user, currentRole: sandbox.role })
      )
        throw new VaultError("not_found", "No such sandbox.");
      const result = await sql.query<Row>(
        `select ${columns} from public.mcp_bindings b
        join public.mcp_connections c on c.id=b.connection_id
        join public.mcp_grants g on g.id=b.grant_id and g.connection_id=c.id
        where b.sandbox_id=$1::uuid and c.org_id=$2::uuid
          and (c.scope='org' or c.owner_id=$3::uuid) order by c.name,c.id`,
        [sandboxId, org, user],
      );
      return result.rows.map(dto);
    },
    async revoke(user, org, id, remove = false) {
      await get(user, org, id, true);
      if (remove) await sql.query("delete from public.mcp_connections where id=$1::uuid", [id]);
      else
        await sql.query(
          "update public.mcp_grants set value_enc=null,status='not_connected',revoked_at=now(),generation=generation+1,version=version+1,refresh_owner=null,refresh_until=null where connection_id=$1::uuid",
          [id],
        );
    },
  };
}
function validateInput(i: McpConnectionInput) {
  if (
    !i ||
    !["personal", "org"].includes(i.scope) ||
    !["http", "sse", "stdio"].includes(i.transport) ||
    !["auto", "none", "bearer", "headers", "oauth"].includes(i.authType ?? "auto") ||
    typeof i.name !== "string" ||
    !i.name.trim() ||
    i.name.length > 200
  )
    throw new VaultError("invalid", "Invalid MCP definition.");
  if (i.transport === "stdio") {
    if (
      !i.command ||
      i.url ||
      i.authType !== "none" ||
      !Array.isArray(i.args ?? []) ||
      (i.args ?? []).some((a) => typeof a !== "string")
    )
      throw new VaultError("invalid", "stdio requires a command, string args and no authentication.");
    validatePinnedStdio(i.command, i.args ?? []);
  } else {
    let url: URL;
    try {
      url = new URL(i.url ?? "");
    } catch {
      throw new VaultError("invalid", "An HTTPS MCP URL is required.");
    }
    const authority = i.url?.trim().match(/^https:\/\/([^/?#]*)/i)?.[1];
    if (
      !authority ||
      authority.includes("@") ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      i.url?.includes("#") ||
      i.command
    )
      throw new VaultError("invalid", "Use an HTTPS URL without userinfo or fragments.");
    for (const key of url.searchParams.keys()) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        /token|secret|password|passwd|apikey|authorization|credential|privatekey|signingkey/.test(normalized) ||
        /^(auth|key|sig|signature|jwt|bearer)$/.test(normalized)
      )
        throw new VaultError(
          "invalid",
          "Credentials in MCP URL parameters are not allowed. Use write-only authentication.",
        );
    }
  }
  if (i.authentication === undefined) return;
  if (
    typeof i.authentication !== "string" ||
    !i.authentication.trim() ||
    (i.authType !== "bearer" && i.authType !== "headers" && i.authType !== "oauth")
  )
    throw new VaultError("invalid", "Use write-only bearer, headers or OAuth preregistration authentication.");
  if (i.authType === "bearer") {
    if (/[\r\n]/.test(i.authentication))
      throw new VaultError("invalid", "Bearer authentication cannot contain line breaks.");
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(i.authentication);
  } catch {
    throw new VaultError("invalid", "Headers and OAuth preregistration authentication must be JSON objects.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new VaultError("invalid", "Headers and OAuth preregistration authentication must be JSON objects.");
  if (i.authType === "headers") {
    for (const [name, value] of Object.entries(payload)) {
      if (!/^[!#$%&'*+.^_~`|0-9A-Za-z-]+$/.test(name) || typeof value !== "string" || /[\r\n]/.test(value))
        throw new VaultError(
          "invalid",
          "Authentication headers require valid header names and string values without line breaks.",
        );
    }
  }
}

/** Only deterministic package entrypoints, never a shell or an unpinned package alias. */
function validatePinnedStdio(command: string, args: string[]) {
  try {
    parsePinnedMcpStdio(command, args);
  } catch (error) {
    if (error instanceof McpStdioError && error.category === "arguments")
      throw new VaultError("invalid", "stdio arguments cannot contain control characters.");
    throw new VaultError(
      "invalid",
      "stdio requires npx [-y|--yes] package@exact.version or uvx package==exact.version.",
    );
  }
}

export interface McpGrantSnapshot {
  id: string;
  value_enc: Uint8Array<ArrayBuffer> | null;
  generation: number;
  version: number;
}
export interface McpLeaseClaims {
  id: string;
  connection_id: string;
  sandbox_id: string;
  org_id: string;
  owner_id: string;
}
export type McpGrantPort = ReturnType<typeof createSqlMcpGrantPort>;
export type McpLeasePort = ReturnType<typeof createSqlMcpLeasePort>;
export type McpLaunchPort = ReturnType<typeof createSqlMcpLaunchPort>;

/** Trusted broker SQL port: ciphertext only, CAS rotation, exclusive refresh ownership, revocation fencing. */
export function createSqlMcpGrantPort(sql: Sql) {
  return {
    /** A real upstream probe resolves auto. A revoked/replaced discovery cannot publish its result. */
    async discovered(connectionId: string, generation: number, authType: "none" | "oauth") {
      const r = await sql.query<{ id: string }>(
        `with current_grant as (
          update public.mcp_grants g set status=case when $3='none' then 'connected' else 'not_connected' end,
            version=version+1,refresh_owner=null,refresh_until=null
          where g.connection_id=$1::uuid and g.generation=$2 and g.revoked_at is null and not g.refresh_consumed
          and exists(select 1 from public.mcp_connections c where c.id=g.connection_id and c.auth_type='auto' and not c.disabled)
          returning connection_id)
        update public.mcp_connections c set auth_type=$3 from current_grant g where c.id=g.connection_id returning c.id`,
        [connectionId, generation, authType],
      );
      return r.rows.length === 1;
    },
    /** Only after the control layer authorized an explicit reconnect. */
    async begin(connectionId: string) {
      return (
        (
          await sql.query<McpGrantSnapshot>(
            "update public.mcp_grants set generation=generation+1,version=version+1,value_enc=null,revoked_at=null,status='not_connected',refresh_owner=null,refresh_until=null,refresh_consumed=false where connection_id=$1::uuid and exists(select 1 from public.mcp_connections c where c.id=mcp_grants.connection_id and not c.disabled) returning id,value_enc,generation,version",
            [connectionId],
          )
        ).rows[0] ?? null
      );
    },
    async acquire(connectionId: string, owner: string, seconds = 30) {
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300)
        throw new VaultError("invalid", "Refresh lease must be 1–300 seconds.");
      return (
        (
          await sql.query<McpGrantSnapshot>(
            `update public.mcp_grants set refresh_consumed=true,refresh_owner=$2::uuid,refresh_until=now()+($3 * interval '1 second')
        where connection_id=$1::uuid and revoked_at is null and not refresh_consumed and exists(select 1 from public.mcp_connections c where c.id=mcp_grants.connection_id and not c.disabled) and (refresh_until is null or refresh_until<now())
        returning id,value_enc,generation,version`,
            [connectionId, owner, seconds],
          )
        ).rows[0] ?? null
      );
    },
    async rotate(id: string, owner: string, version: number, generation: number, ciphertext: Uint8Array | null) {
      const r = await sql.query(
        `update public.mcp_grants set value_enc=$5::bytea,version=version+1,status='connected',
        refresh_consumed=false,refresh_owner=null,refresh_until=null where id=$1::uuid and refresh_owner=$2::uuid and version=$3 and generation=$4
        and refresh_consumed and revoked_at is null and refresh_until>now()
        and exists(select 1 from public.mcp_connections c where c.id=mcp_grants.connection_id and c.auth_type<>'auto' and not c.disabled) returning id`,
        [id, owner, version, generation, ciphertext],
      );
      return r.rows.length === 1;
    },
  };
}

/** Gateway validates a hashed scoped token against current membership, sandbox and grant generations. */
export function createSqlMcpLeasePort(sql: Sql) {
  return {
    async issue(input: {
      sandboxId: string;
      connectionId: string;
      tokenHash: string;
      operations: string[];
      expiresAt: Date;
    }) {
      if (
        !/^[a-f0-9]{64}$/.test(input.tokenHash) ||
        !input.operations.length ||
        input.operations.some((op) => !["tools", "resources", "prompts"].includes(op))
      )
        throw new VaultError("invalid", "Invalid lease scope.");
      const r = await sql.query<{ id: string }>(
        `insert into public.mcp_leases(sandbox_id,connection_id,grant_id,org_id,owner_id,generation,sandbox_generation,hash,operations,expires_at)
        select s.id,c.id,g.id,s.org_id,s.owner_id,g.generation,s.mcp_generation,$3,$4::text[],$5
        from public.mcp_bindings b join public.sandboxes s on s.id=b.sandbox_id
        join public.mcp_connections c on c.id=b.connection_id join public.mcp_grants g on g.id=b.grant_id
        where b.sandbox_id=$1::uuid and b.connection_id=$2::uuid and not c.disabled and public.mcp_grant_effective_status(g.status,g.revoked_at,g.refresh_consumed,g.refresh_until)='connected'
        and g.revoked_at is null and s.status not in ('stopped','deleted','failed')
        and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id)
        and c.org_id=s.org_id and g.connection_id=c.id and (c.scope='org' or c.owner_id=s.owner_id)
        returning id`,
        [input.sandboxId, input.connectionId, input.tokenHash, input.operations, input.expiresAt],
      );
      if (!r.rows[0]) throw new VaultError("forbidden", "No active MCP binding.");
      return r.rows[0];
    },
    async validate(tokenHash: string, operation: string) {
      return (
        (
          await sql.query<McpLeaseClaims>(
            `select l.id,l.connection_id,l.sandbox_id,l.org_id,l.owner_id from public.mcp_leases l
        join public.sandboxes s on s.id=l.sandbox_id join public.mcp_connections c on c.id=l.connection_id
        join public.mcp_grants g on g.id=l.grant_id
        where l.hash=$1 and $2=any(l.operations) and l.expires_at>now() and l.revoked_at is null
        and g.revoked_at is null and public.mcp_grant_effective_status(g.status,g.revoked_at,g.refresh_consumed,g.refresh_until)='connected' and not c.disabled
        and l.generation=g.generation and l.sandbox_generation=s.mcp_generation
        and s.status not in ('stopped','deleted','failed')
        and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id)
        and c.org_id=s.org_id and g.connection_id=c.id and (c.scope='org' or c.owner_id=s.owner_id)`,
            [tokenHash, operation],
          )
        ).rows[0] ?? null
      );
    },
    async invalidateSandbox(sandboxId: string) {
      await sql.query("update public.sandboxes set mcp_generation=mcp_generation+1 where id=$1::uuid", [sandboxId]);
    },
  };
}
export function createSqlMcpLaunchPort(sql: Sql, registry: McpRegistry) {
  return {
    async defaults(actor: { userId: string; orgId: string }, _visibility: "private" | "org") {
      return mcpLaunchSelection(await registry.list(actor.userId, actor.orgId)).ids;
    },
    async validate(actor: { userId: string; orgId: string }, ids: string[], _visibility: "private" | "org") {
      for (const id of ids) {
        const c = await registry.get(actor.userId, actor.orgId, id);
        if (c.status !== "connected")
          throw new VaultError(
            "forbidden",
            "Please reconnect every selected MCP connection before launching, or explicitly select connections to continue without it.",
          );
      }
    },
    async bind(sandboxId: string, ids: string[]) {
      if (!ids.length) return;
      const bound = await sql.query(
        `insert into public.mcp_bindings(sandbox_id,connection_id,grant_id)
        select $1::uuid,c.id,g.id from unnest($2::uuid[]) selected(id)
        join public.mcp_connections c on c.id=selected.id join public.mcp_grants g on g.connection_id=c.id returning connection_id`,
        [sandboxId, ids],
      );
      if (bound.rows.length !== ids.length)
        throw new VaultError("conflict", "A selected MCP connection was removed during launch.");
    },
  };
}

export interface McpPendingOAuthFlow {
  actorId: string;
  orgId: string;
  connectionId: string;
  generation: number;
  /** Decrypted only after an authorized atomic take, for the trusted broker. */
  payload: string;
}
export type McpPendingOAuthPort = ReturnType<typeof createSqlMcpPendingOAuthPort>;
/** State is hashed before this port; payload is sealed using the existing vault key. */
export function createSqlMcpPendingOAuthPort(sql: Sql, encryptionKey: string | undefined) {
  return {
    async put(input: McpPendingOAuthFlow & { stateHash: string; expiresAt: Date }) {
      if (!/^[a-f0-9]{64}$/.test(input.stateHash)) throw new VaultError("invalid", "Invalid OAuth state hash.");
      const ciphertext = await encryptSecret(input.payload, encryptionKey);
      const r = await sql.query<{ hash: string }>(
        `insert into public.mcp_pending_oauth(hash,actor_id,org_id,connection_id,generation,expires_at,payload_enc)
        select $1,$2::uuid,c.org_id,c.id,g.generation,$6,$7::bytea from public.mcp_connections c
        join public.mcp_grants g on g.connection_id=c.id join public.members m on m.org_id=c.org_id and m.user_id=$2::uuid
        where c.id=$3::uuid and c.org_id=$4::uuid and g.generation=$5 and g.revoked_at is null and not c.disabled
        and ((c.scope='personal' and c.owner_id=$2::uuid) or (c.scope='org' and m.role='admin'))
        and $6::timestamptz>now() returning hash`,
        [
          input.stateHash,
          input.actorId,
          input.connectionId,
          input.orgId,
          input.generation,
          input.expiresAt,
          ciphertext,
        ],
      );
      if (!r.rows[0]) throw new VaultError("forbidden", "OAuth flow is no longer authorized.");
    },
    async take(actorId: string, stateHash: string): Promise<McpPendingOAuthFlow | null> {
      if (!/^[a-f0-9]{64}$/.test(stateHash)) return null;
      const r = await sql.query<{
        actor_id: string;
        org_id: string;
        connection_id: string;
        generation: number;
        payload_enc: Uint8Array<ArrayBuffer>;
      }>(
        `delete from public.mcp_pending_oauth p using public.mcp_connections c,public.mcp_grants g,public.members m
         where p.hash=$1 and p.actor_id=$2::uuid and p.expires_at>now()
         and c.id=p.connection_id and c.org_id=p.org_id and not c.disabled
         and g.connection_id=c.id and g.generation=p.generation and g.revoked_at is null
         and m.org_id=p.org_id and m.user_id=p.actor_id
         and ((c.scope='personal' and c.owner_id=p.actor_id) or (c.scope='org' and m.role='admin'))
         returning p.actor_id,p.org_id,p.connection_id,p.generation,p.payload_enc`,
        [stateHash, actorId],
      );
      const flow = r.rows[0];
      if (!flow) return null;
      return {
        actorId: flow.actor_id,
        orgId: flow.org_id,
        connectionId: flow.connection_id,
        generation: flow.generation,
        payload: await decryptSecret(flow.payload_enc, encryptionKey),
      };
    },
    async purgeExpired() {
      await sql.query("delete from public.mcp_pending_oauth where expires_at<=now()");
    },
  };
}
export interface McpInvalidation {
  id: string;
  connectionId: string | null;
  sandboxId: string | null;
  orgId: string;
  generation: number | null;
  reason: "grant" | "definition" | "membership" | "sandbox";
}
export type McpInvalidationPort = ReturnType<typeof createSqlMcpInvalidationPort>;
/** Every live gateway replica drains its own feed; acknowledge only after closing affected streams. */
export function createSqlMcpInvalidationPort(sql: Sql) {
  return {
    async pending(replicaId: string, limit = 100): Promise<McpInvalidation[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new VaultError("invalid", "Invalid invalidation batch size.");
      const r = await sql.query<{
        id: string;
        connection_id: string | null;
        sandbox_id: string | null;
        org_id: string;
        generation: number | null;
        reason: McpInvalidation["reason"];
      }>(
        `select e.id::text,e.connection_id,e.sandbox_id,e.org_id,e.generation,e.reason from public.mcp_invalidations e
         where not exists(select 1 from public.mcp_invalidation_deliveries d where d.replica_id=$1::uuid and d.event_id=e.id)
         order by e.id limit $2`,
        [replicaId, limit],
      );
      return r.rows.map((e) => ({
        id: e.id,
        connectionId: e.connection_id,
        sandboxId: e.sandbox_id,
        orgId: e.org_id,
        generation: e.generation,
        reason: e.reason,
      }));
    },
    async acknowledge(replicaId: string, ids: string[]) {
      if (!ids.length) return;
      await sql.query(
        `insert into public.mcp_invalidation_deliveries(replica_id,event_id)
        select $1::uuid,id from public.mcp_invalidations where id=any($2::bigint[]) on conflict do nothing`,
        [replicaId, ids],
      );
    },
  };
}
