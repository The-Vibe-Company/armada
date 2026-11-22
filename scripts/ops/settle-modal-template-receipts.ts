import { settleModalTemplateReceipts } from "../../packages/mcp-server/src/modal-template-receipt-settlement.ts";
import { bunSql } from "../../packages/mcp-server/src/sql.ts";

if (import.meta.main) {
  const [mode, ...extra] = Bun.argv.slice(2);
  if (extra.length || (mode !== "--dry-run" && mode !== "--apply")) {
    process.stderr.write(
      "Usage: bun scripts/ops/settle-modal-template-receipts.ts --dry-run|--apply < reviewed.json\n",
    );
    process.exitCode = 1;
  } else {
    const dryRun = mode === "--dry-run";
    const variable = dryRun ? "ARMADA_DRAIN_READ_ONLY_DATABASE_URL" : "ARMADA_DATABASE_URL";
    const url = Bun.env[variable];
    if (!url || !/^postgres(?:ql)?:\/\//.test(url)) {
      process.stderr.write(`Set ${variable} for template receipt settlement.\n`);
      process.exitCode = 1;
    } else {
      const sql = bunSql(url, 1);
      try {
        const report = await settleModalTemplateReceipts(sql, await Bun.stdin.json(), dryRun);
        process.stdout.write(`${JSON.stringify({ mode, report }, null, 2)}\n`);
        if (report.some(({ decision }) => decision === "deferred" || decision === "busy")) process.exitCode = 1;
      } catch {
        process.stderr.write(
          "Template receipt settlement could not finish. Check reviewed input and database access.\n",
        );
        process.exitCode = 1;
      } finally {
        await sql.close();
      }
    }
  }
}
