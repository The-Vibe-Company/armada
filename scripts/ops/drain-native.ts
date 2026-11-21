import { SQL } from "bun";
import { SANDBOX_STATES, type SandboxState } from "../../packages/core/src/provider.ts";

type NativeProvider = "modal" | "boat";
type StatusCount = { status: SandboxState; count: number };
type InventoryQuery = (statement: string, provider: NativeProvider) => Promise<StatusCount[]>;

const usage = "Usage: bun scripts/ops/drain-native.ts --provider modal|boat --dry-run";
const inventoryQuery = `
  select s.status::text as status, count(*)::int as count
  from public.sandboxes s
  where s.provider = $1
    and not s.boat_runtime
    and s.runtime_transport is distinct from 'dialout'
    and s.deleted_at is null
    and s.status <> 'deleted'
  group by s.status
`;

export async function runNativeDrain(args: readonly string[], query: InventoryQuery) {
  const [flag, provider, mode] = args;
  if (flag !== "--provider" || (provider !== "modal" && provider !== "boat") || args.length > 3) throw new Error(usage);
  if (mode === undefined) throw new Error("Destructive drain is unavailable. Use --dry-run for inventory.");
  if (mode !== "--dry-run") throw new Error(usage);

  const counts = await query(inventoryQuery, provider);
  const byStatus = Object.fromEntries(SANDBOX_STATES.map((status) => [status, 0]));
  for (const { status, count } of counts) byStatus[status] = count;
  return {
    provider,
    mode: "dry-run",
    total: counts.reduce((sum, row) => sum + row.count, 0),
    byStatus,
  };
}

async function queryInventory(statement: string, provider: NativeProvider) {
  const url = Bun.env.ARMADA_DRAIN_READ_ONLY_DATABASE_URL;
  if (!url || !/^postgres(?:ql)?:\/\//.test(url))
    throw new Error("Set ARMADA_DRAIN_READ_ONLY_DATABASE_URL for the coordinator's inventory.");
  try {
    const client = new SQL(url, { max: 1, connectionTimeout: 10 });
    try {
      return await client.begin("READ ONLY", async (tx) => {
        await tx.unsafe("SET LOCAL row_security = off");
        await tx.unsafe("SET LOCAL statement_timeout = '30s'");
        return tx.unsafe<StatusCount[]>(statement, [provider]);
      });
    } finally {
      await client.close();
    }
  } catch {
    throw new Error("Native sandbox inventory failed. Check database connectivity and unfiltered read access.");
  }
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runNativeDrain(Bun.argv.slice(2), queryInventory), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Native sandbox inventory failed.");
    process.exitCode = 1;
  }
}
