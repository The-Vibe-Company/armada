import { readFile } from "node:fs/promises";
/** Coordinator-only, explicit receipt manifest; never discovers candidates from fleet state. */
import { deleteSmokeReceipts, STAGING_ORIGIN, smokeReceipts } from "./smoke-sandbox-cleanup.ts";

export async function cleanupStagingSmoke(
  env: NodeJS.ProcessEnv,
  args: string[],
  io: { fetch: (url: string, init: RequestInit) => Promise<Response>; out: (line: string) => void },
): Promise<boolean> {
  // Origin is checked even in dry-run, before touching a manifest or making a request.
  if (env.ARMADA_URL !== STAGING_ORIGIN) throw new Error("staging_only");
  if (args.some((arg) => arg !== "--delete") || !env.ARMADA_SMOKE_JOURNAL || !env.ARMADA_SMOKE_ORG)
    throw new Error("Set ARMADA_SMOKE_JOURNAL and ARMADA_SMOKE_ORG; optional --delete.");
  const rows = smokeReceipts(JSON.parse(await readFile(env.ARMADA_SMOKE_JOURNAL, "utf8")));
  if (rows.some((row) => row.org !== env.ARMADA_SMOKE_ORG)) throw new Error("manifest_org_mismatch");
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  io.out(
    JSON.stringify({
      step: "historical_smoke_plan",
      dryRun: !args.includes("--delete"),
      candidates: unique.length,
      batchLimit: 32,
    }),
  );
  if (!args.includes("--delete")) return true;
  if (!env.ARMADA_TOKEN) throw new Error("ARMADA_TOKEN is required for --delete.");
  const remaining = await deleteSmokeReceipts(STAGING_ORIGIN, env.ARMADA_TOKEN, unique, io);
  io.out(
    JSON.stringify({
      step: "historical_smoke_result",
      deleted: unique.length - remaining.length,
      remaining: remaining.length,
    }),
  );
  // Preserve the input as audit evidence. Re-running explicit IDs is safe/idempotent.
  return remaining.length === 0;
}

if (import.meta.main) {
  try {
    if (!(await cleanupStagingSmoke(process.env, Bun.argv.slice(2), { fetch, out: console.log }))) process.exitCode = 1;
  } catch {
    console.error("Staging cleanup refused or failed; verify origin, organization and smoke receipt manifest.");
    process.exitCode = 1;
  }
}
