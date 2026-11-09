/** Operator-only: registration JSON on stdin; only encrypted deployment configuration on stdout. */
import { encryptSecret } from "../packages/core/src/crypto.ts";
import { dashboardOrigin } from "../packages/mcp-server/src/config.ts";
import { validateSlackRegistration } from "../packages/mcp-server/src/mcp-catalog-client.ts";

try {
  const callback = `${dashboardOrigin(process.env.ARMADA_DASHBOARD_URL, process.env.NODE_ENV === "development")}/auth/mcp/callback`;
  const input = await Bun.stdin.text();
  validateSlackRegistration(JSON.parse(input), callback);
  const sealed = await encryptSecret(input, process.env.ARMADA_ENCRYPTION_KEY);
  process.stdout.write(`${Buffer.from(sealed).toString("base64")}\n`);
} catch {
  process.stderr.write(
    "Could not seal Slack registration; verify stdin JSON, callback, scopes and ARMADA_ENCRYPTION_KEY.\n",
  );
  process.exitCode = 1;
}
