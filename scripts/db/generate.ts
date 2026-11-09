import { applyMigrations, openDatabase } from "./apply.ts";

type Column = {
  name: string;
  notNull: boolean;
  hasDefault: boolean;
  tsType: string;
};

type ForeignKey = {
  name: string;
  columns: string[];
  referencedRelation: string;
  referencedColumns: string[];
  isOneToOne: boolean;
};

type Table = {
  name: string;
  columns: Column[];
  foreignKeys: ForeignKey[];
};

type Schema = {
  tables: Table[];
  enums: { name: string; labels: string[] }[];
};

const ROW_ALIASES: Record<string, string> = {
  orchestrator_runtime: "OrchestratorRuntimeRow",
  orchestrator_runtime_create_keys: "OrchestratorRuntimeCreateKeyRow",
  orchestrator_runtime_events: "OrchestratorRuntimeEventRow",
  model_auth_ownership: "ModelAuthOwnershipRow",
  model_auth_state: "ModelAuthStateRow",
  modal_events: "ModalEventRow",
  modal_images: "ModalImageRow",
  modal_machines: "ModalMachineRow",
  modal_server_apps: "ModalServerAppRow",
  modal_server_scopes: "ModalServerScopeRow",
  modal_server_harnesses: "ModalServerHarnessRow",
  orchestrators: "OrchestratorIdentityRow",
  orchestrator_children: "OrchestratorChildRow",
  orchestrator_operations: "OrchestratorOperationRow",
  orchestrator_delegations: "OrchestratorDelegationRow",
  credentials: "Credential",
  github_authorizations: "GitHubAuthorization",
  github_connections: "GitHubConnection",
  golden_build_jobs: "GoldenBuildJob",
  golden_backend_slots: "GoldenBackendSlot",
  golden_adoption_receipts: "GoldenAdoptionReceipt",
  goldens: "Golden",
  golden_operation_fences: "GoldenOperationFence",
  golden_snapshot_publications: "GoldenSnapshotPublication",
  golden_snapshot_retirements: "GoldenSnapshotRetirement",
  mcp_tokens: "McpToken",
  mcp_actor_epochs: "McpActorEpoch",
  mcp_connections: "McpConnection",
  mcp_grants: "McpGrant",
  mcp_bindings: "McpBinding",
  mcp_leases: "McpLease",
  mcp_pending_oauth: "McpPendingOAuth",
  mcp_invalidations: "McpInvalidationEvent",
  mcp_invalidation_deliveries: "McpInvalidationDelivery",
  mcp_bootstraps: "McpBootstrapReceipt",
  members: "Member",
  notify_subscriptions: "NotifySubscription",
  oauth_clients: "OAuthClient",
  oauth_codes: "OAuthCode",
  orgs: "Org",
  organization_invitations: "OrganizationInvitationRow",
  resource_observations: "ResourceObservation",
  sandboxes: "Sandbox",
  service_tokens: "ServiceToken",
};

const ENUM_ALIASES: Record<string, string> = {
  credential_kind: "CredentialKind",
  credential_scope: "CredentialScope",
  member_role: "MemberRole",
  notify_status: "NotifyStatus",
  sandbox_status: "SandboxStatus",
};

/** Renders `packages/core/src/database.types.ts` from the migrations on a fresh database. */
export async function generateDatabaseTypes(): Promise<string> {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    return render(await introspect(db));
  } finally {
    await db.close();
  }
}

async function introspect(db: Awaited<ReturnType<typeof openDatabase>>): Promise<Schema> {
  const columns = await db.query<{
    table_name: string;
    column_name: string;
    not_null: boolean;
    default_expr: string | null;
    type_name: string;
    type_kind: string;
    type_category: string;
    element_name: string | null;
    element_kind: string | null;
  }>(`
    select c.relname as table_name,
           a.attname as column_name,
           a.attnotnull as not_null,
           pg_get_expr(d.adbin, d.adrelid) as default_expr,
           t.typname as type_name,
           t.typtype as type_kind,
           t.typcategory as type_category,
           elem.typname as element_name,
           elem.typtype as element_kind
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid
    join pg_catalog.pg_type t on t.oid = a.atttypid
    left join pg_catalog.pg_type elem on t.typcategory = 'A' and elem.oid = t.typelem
    left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum
  `);

  const enums = await db.query<{ name: string; label: string }>(`
    select t.typname as name, e.enumlabel as label
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    join pg_catalog.pg_enum e on e.enumtypid = t.oid
    where n.nspname = 'public'
    order by t.typname, e.enumsortorder
  `);

  const attributes = await db.query<{ relid: string; attnum: number; name: string }>(`
    select a.attrelid::text as relid, a.attnum::int as attnum, a.attname as name
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where a.attnum > 0 and not a.attisdropped and n.nspname in ('public', 'auth')
  `);
  const attributeName = new Map(attributes.rows.map((row) => [`${row.relid}:${row.attnum}`, row.name]));

  const uniqueKeys = await db.query<{ relid: string; keys: unknown }>(`
    select con.conrelid::text as relid, con.conkey as keys
    from pg_catalog.pg_constraint con
    where con.contype in ('p', 'u')
  `);
  const uniqueByTable = new Map<string, number[][]>();
  for (const row of uniqueKeys.rows) {
    const list = uniqueByTable.get(row.relid) ?? [];
    list.push(numbers(row.keys));
    uniqueByTable.set(row.relid, list);
  }

  const foreignKeys = await db.query<{
    table_name: string;
    name: string;
    keys: unknown;
    ref_table: string;
    ref_keys: unknown;
    relid: string;
    refid: string;
  }>(`
    select src.relname as table_name,
           con.conname as name,
           con.conkey as keys,
           dst.relname as ref_table,
           con.confkey as ref_keys,
           con.conrelid::text as relid,
           con.confrelid::text as refid
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class src on src.oid = con.conrelid
    join pg_catalog.pg_namespace n on n.oid = src.relnamespace
    join pg_catalog.pg_class dst on dst.oid = con.confrelid
    where con.contype = 'f' and n.nspname = 'public'
    order by src.relname, con.conname
  `);

  const enumLabels = new Map<string, string[]>();
  for (const row of enums.rows) {
    const labels = enumLabels.get(row.name) ?? [];
    labels.push(row.label);
    enumLabels.set(row.name, labels);
  }

  const tables = new Map<string, Table>();
  for (const row of columns.rows) {
    let table = tables.get(row.table_name);
    if (!table) {
      table = { name: row.table_name, columns: [], foreignKeys: [] };
      tables.set(row.table_name, table);
    }
    table.columns.push({
      name: row.column_name,
      notNull: row.not_null,
      hasDefault: row.default_expr !== null,
      tsType: columnType(row),
    });
  }

  for (const row of foreignKeys.rows) {
    const table = tables.get(row.table_name);
    if (!table) throw new Error(`foreign key ${row.name} is on an unknown table`);
    const keys = numbers(row.keys);
    const unique = uniqueByTable.get(row.relid) ?? [];
    table.foreignKeys.push({
      name: row.name,
      columns: names(attributeName, row.relid, keys),
      referencedRelation: row.ref_table,
      referencedColumns: names(attributeName, row.refid, numbers(row.ref_keys)),
      isOneToOne: unique.some((key) => sameSet(key, keys)),
    });
  }

  return {
    tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)),
    enums: [...enumLabels.entries()]
      .map(([name, labels]) => ({ name, labels }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function columnType(row: {
  type_name: string;
  type_kind: string;
  type_category: string;
  element_name: string | null;
  element_kind: string | null;
}): string {
  if (row.type_category === "A") {
    if (!row.element_name || !row.element_kind) throw new Error(`array ${row.type_name} has no element type`);
    return `${scalarType(row.element_name, row.element_kind)}[]`;
  }
  return scalarType(row.type_name, row.type_kind);
}

function scalarType(name: string, kind: string): string {
  if (kind === "e") return `Database["public"]["Enums"]["${name}"]`;
  switch (name) {
    case "uuid":
    case "text":
    case "timestamptz":
    case "bytea":
    case "varchar":
      return "string";
    case "json":
    case "jsonb":
      return "Json";
    case "bool":
      return "boolean";
    case "int2":
    case "int4":
    case "int8":
    case "float4":
    case "float8":
    case "numeric":
      return "number";
    default:
      throw new Error(`unsupported column type ${name}`);
  }
}

function numbers(value: unknown): number[] {
  if (Array.isArray(value)) return value.map((item) => Number(item));
  if (typeof value === "string") {
    return value
      .replace(/[{}]/g, "")
      .split(",")
      .filter((part) => part.length > 0)
      .map((part) => Number(part));
  }
  throw new Error(`expected a postgres int array, got ${typeof value}`);
}

function names(attributes: Map<string, string>, relid: string, keys: number[]): string[] {
  return keys.map((attnum) => {
    const name = attributes.get(`${relid}:${attnum}`);
    if (!name) throw new Error(`missing attribute ${relid} column ${attnum}`);
    return name;
  });
}

function sameSet(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function render(schema: Schema): string {
  const tables = schema.tables
    .map((table) => {
      const relationships =
        table.foreignKeys.length === 0
          ? "[]"
          : `[\n${table.foreignKeys.map((key) => relationship(key)).join(",\n")},\n        ]`;
      return `      ${table.name}: {
        Row: {
${table.columns.map((column) => field(column.name, column.tsType, false, column.notNull)).join("\n")}
        };
        Insert: {
${table.columns.map((column) => field(column.name, column.tsType, !column.notNull || column.hasDefault, column.notNull)).join("\n")}
        };
        Update: {
${table.columns.map((column) => field(column.name, column.tsType, true, column.notNull)).join("\n")}
        };
        Relationships: ${relationships};
      };`;
    })
    .join("\n");

  const enums = schema.enums
    .map((item) => `      ${item.name}: ${item.labels.map((label) => JSON.stringify(label)).join(" | ")};`)
    .join("\n");

  const aliases = [
    ...schema.tables.map((table) => {
      const alias = ROW_ALIASES[table.name];
      if (!alias) throw new Error(`no row alias for table ${table.name}`);
      return `export type ${alias} = Database["public"]["Tables"]["${table.name}"]["Row"];`;
    }),
    ...schema.enums.flatMap((item) => {
      const alias = ENUM_ALIASES[item.name];
      return alias ? [`export type ${alias} = Database["public"]["Enums"]["${item.name}"];`] : [];
    }),
  ].join("\n");

  return `// Generated from supabase/migrations by \`bun run db:types\`. Do not edit.
import type { SandboxListMetadata } from "./sandbox-access.ts";

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
${tables}
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      sandbox_list_metadata: { Args: Record<string, never>; Returns: SandboxListMetadata[] };
      can_open_sandbox: { Args: { target_org: string; target_owner: string }; Returns: boolean };
    };
    Enums: {
${enums}
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

${aliases}
`;
}

function field(name: string, tsType: string, optional: boolean, notNull: boolean): string {
  const type = notNull ? tsType : `${tsType} | null`;
  return `          ${name}${optional ? "?" : ""}: ${type};`;
}

function relationship(key: ForeignKey): string {
  return `          {
            foreignKeyName: ${JSON.stringify(key.name)};
            columns: [${key.columns.map((name) => JSON.stringify(name)).join(", ")}];
            isOneToOne: ${key.isOneToOne};
            referencedRelation: ${JSON.stringify(key.referencedRelation)};
            referencedColumns: [${key.referencedColumns.map((name) => JSON.stringify(name)).join(", ")}];
          }`;
}
