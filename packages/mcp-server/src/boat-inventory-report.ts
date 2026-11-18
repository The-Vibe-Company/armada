import type { Sql } from "@armada/core";
import { createSqlVaultStore, decryptSecret } from "@armada/core/server";
import { type BoatProvider, createBoatProvider } from "@armada/provider-boat";
import { bunSql } from "./sql.ts";

export async function reportBoatInventory(
  sql: Sql,
  provider: Pick<BoatProvider, "listSandboxInventory">,
  deploymentId: string,
) {
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let unmatched = 0;
  let cursor: string | undefined;
  do {
    const page = await provider.listSandboxInventory(cursor === undefined ? undefined : { cursor });
    const ids = [];
    for (const item of page.items) {
      if (item.deploymentId !== deploymentId || seen.has(item.sandboxId)) continue;
      seen.add(item.sandboxId);
      ids.push(item.sandboxId);
    }
    if (ids.length > 0) {
      const { rows } = await sql.query<{ provider_sandbox_id: string }>(
        `select provider_sandbox_id from public.sandboxes
         where provider = 'boat' and provider_sandbox_id = any($1::text[])`,
        [ids],
      );
      unmatched += ids.length - rows.length;
    }
    if (page.cursor !== null) {
      if (cursors.has(page.cursor)) throw new Error("Boat inventory repeated a page cursor.");
      cursors.add(page.cursor);
    }
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return { observed: seen.size, matched: seen.size - unmatched, unmatched };
}

async function main([confirmation, scope, ownerId, ...extra]: readonly string[], env: NodeJS.ProcessEnv) {
  if (
    confirmation !== "--production-boat" ||
    (scope !== "org" && scope !== "user") ||
    !ownerId ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(ownerId) ||
    extra.length > 0
  ) {
    console.error(
      "Usage: bun packages/mcp-server/src/boat-inventory-report.ts --production-boat <org|user> <owner-uuid>",
    );
    return 1;
  }
  const deploymentId = env.ARMADA_BOAT_DEPLOYMENT_ID?.trim();
  const databaseUrl = env.ARMADA_DATABASE_URL?.trim();
  const encryptionKey = env.ARMADA_ENCRYPTION_KEY?.trim();
  if (!deploymentId || !databaseUrl || !encryptionKey) {
    console.error("Set ARMADA_BOAT_DEPLOYMENT_ID, ARMADA_DATABASE_URL and ARMADA_ENCRYPTION_KEY for this deployment.");
    return 1;
  }
  const sql = bunSql(databaseUrl, 1, 5_000);
  try {
    const store = createSqlVaultStore(sql);
    const sealed =
      scope === "org"
        ? await store.orgBoatKey(ownerId)
        : (await store.credentials("user", ownerId)).find((row) => row.kind === "boat")?.valueEnc;
    if (!sealed) {
      console.error("No Boat key is configured for the selected owner.");
      return 1;
    }
    const apiKey = await decryptSecret(new Uint8Array(sealed), encryptionKey);
    const provider = createBoatProvider({ apiKey, deploymentId });
    const counts = await reportBoatInventory(sql, provider, deploymentId);
    console.log(JSON.stringify({ event: "boat_sandbox_inventory_report", scope, ...counts }));
    return 0;
  } finally {
    await sql.close();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch {
    console.error("Boat sandbox inventory report failed.");
    process.exitCode = 1;
  }
}
