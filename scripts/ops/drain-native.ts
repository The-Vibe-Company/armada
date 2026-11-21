import { Console } from "node:console";
import { Writable } from "node:stream";
import type { MemberRole } from "../../packages/core/src/database.types.ts";
import type { Sql } from "../../packages/core/src/golden-store.ts";
import { SANDBOX_STATES, type SandboxState } from "../../packages/core/src/provider.ts";
import { bunSql } from "../../packages/mcp-server/src/sql.ts";

const nativeProviders = ["modal", "boat"] as const;
type NativeProvider = (typeof nativeProviders)[number];
type StatusCount = { status: SandboxState; count: number };
type NativeRow = { id: string; org_id: string; role: MemberRole | null };
type DeleteNativeRow = (row: NativeRow) => Promise<void>;
type NativeDrainRequest = { provider: NativeProvider; dryRun: boolean };

const usage = `Usage: bun scripts/ops/drain-native.ts --provider ${nativeProviders.join("|")} [--dry-run]`;
const nativeCohort = `
  where s.provider = $1
    and not s.boat_runtime
    and s.runtime_transport is distinct from 'dialout'
    and s.deleted_at is null
    and s.status <> 'deleted'
`;
const inventoryQuery = `
  select s.status::text as status, count(*)::int as count
  from public.sandboxes s
  ${nativeCohort}
  group by s.status
`;
const candidatesQuery = `
  select s.id, s.org_id, m.role
  from public.sandboxes s
  left join public.members m on m.org_id = s.org_id and m.user_id = $2::uuid
  ${nativeCohort}
  order by s.id
`;

export function parseNativeDrainArgs(args: readonly string[]) {
  const [flag, requestedProvider, mode] = args;
  const provider = nativeProviders.find((candidate) => candidate === requestedProvider);
  if (flag !== "--provider" || !provider || args.length > 3 || (mode !== undefined && mode !== "--dry-run"))
    throw new Error(usage);
  return { provider, dryRun: mode === "--dry-run" };
}

async function inventory<Row>(sql: Sql, statement: string, params: string[]) {
  if (!sql.transaction) throw new Error("Native sandbox inventory requires database transactions.");
  return sql.transaction(async (tx) => {
    await tx.query("SET TRANSACTION READ ONLY");
    await tx.query("SET LOCAL row_security = off");
    await tx.query("SET LOCAL statement_timeout = '30s'");
    return (await tx.query<Row>(statement, params)).rows;
  });
}

export async function runNativeDrain(
  { provider, dryRun }: NativeDrainRequest,
  sql: Sql,
  operation?: { actorId: string; remove: DeleteNativeRow },
) {
  if (dryRun) {
    const counts = await inventory<StatusCount>(sql, inventoryQuery, [provider]);
    const byStatus = Object.fromEntries(SANDBOX_STATES.map((status) => [status, 0]));
    for (const { status, count } of counts) byStatus[status] = count;
    return {
      provider,
      mode: "dry-run" as const,
      total: counts.reduce((sum, row) => sum + row.count, 0),
      byStatus,
    };
  }
  if (!operation) throw new Error("Native drain deletion requires a configured operator.");
  const rows = await inventory<NativeRow>(sql, candidatesQuery, [provider, operation.actorId]);
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await operation.remove(row);
      deleted++;
    } catch {
      failed++;
    }
  }
  return { provider, mode: "drain" as const, total: rows.length, deleted, failed };
}

async function execute({ provider, dryRun }: NativeDrainRequest) {
  const variable = dryRun ? "ARMADA_DRAIN_READ_ONLY_DATABASE_URL" : "ARMADA_DATABASE_URL";
  const url = Bun.env[variable];
  if (!url || !/^postgres(?:ql)?:\/\//.test(url)) {
    process.stderr.write(`Set ${variable} for native drain.\n`);
    return 1;
  }
  const actorId = Bun.env.ARMADA_DRAIN_ACTOR_ID;
  if (!dryRun && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(actorId ?? "")) {
    process.stderr.write("Set ARMADA_DRAIN_ACTOR_ID to the authorized operator's user UUID.\n");
    return 1;
  }
  if (!dryRun) {
    // WARNING: Provider diagnostics can contain private IDs. Only print aggregate results from this CLI.
    Object.defineProperty(globalThis, "console", {
      value: new Console(new Writable({ write: (_chunk, _encoding, done) => done() })),
    });
  }
  const sql = bunSql(url, 1);
  try {
    const request = { provider, dryRun };
    const report =
      dryRun || !actorId ? await runNativeDrain(request, sql) : await executeDeletion(request, sql, actorId);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.mode === "drain" && report.failed > 0 ? 1 : 0;
  } finally {
    await sql.close();
  }
}

async function executeDeletion(request: NativeDrainRequest, sql: Sql, actorId: string) {
  const { configureNativeDrain } = await import("../../packages/mcp-server/src/native-drain.ts");
  const { remove, settle } = configureNativeDrain(sql, request.provider, actorId, Bun.env);
  try {
    return await runNativeDrain(request, sql, { actorId, remove });
  } finally {
    await settle();
  }
}

if (import.meta.main) {
  let request: NativeDrainRequest | undefined;
  try {
    request = parseNativeDrainArgs(Bun.argv.slice(2));
  } catch {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 1;
  }
  if (request) {
    try {
      process.exitCode = await execute(request);
    } catch {
      process.stderr.write("Native drain could not finish. Check configuration and unfiltered database access.\n");
      process.exitCode = 1;
    }
  }
}
