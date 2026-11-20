import { AuthError } from "@armada/auth";
import { serviceTokenExpiry, tokenOperations } from "@armada/core/contract";
import { createArmadaApiClient } from "../armada-api.ts";
import { parseAuth, rejectUnknown } from "./auth-args.ts";
import type { Command } from "./command.ts";

const createUsage = "armada token create --name <name> [--org <org>] [--expires 30d|90d|1y|never] [--json]";
const listUsage = "armada token ls [--json]";
const revokeUsage = "armada token revoke <id> [--json]";

export default {
  name: "token",
  summary: "Manage API keys",
  usage: { session: `  ${createUsage}\n  ${listUsage}\n  ${revokeUsage}` },
  help: `Usage: armada token <create|ls|revoke>
Manage API keys with a personal login. Use a subcommand's --help for details.
`,
  subcommandHelp: {
    "token create": `Usage: ${createUsage}
Create an API key with a personal login. Expiry defaults to 30 days.
Stdout contains the key once, including with --json. Store it securely.
`,
    "token ls": `Usage: ${listUsage}
List API key metadata. Use the key ID to revoke it.
`,
    "token revoke": `Usage: ${revokeUsage}
Revoke an API key by its ID from armada token ls.
`,
  },
  helpWhenBare: true,
  useSelectedOrg: (argv) => argv[0] === "create",
  async run(argv, { auth }) {
    const {
      position: [sub, id, extra],
      flags,
    } = parseAuth(argv);
    if (auth.env.ARMADA_TOKEN)
      throw new AuthError("Unset ARMADA_TOKEN and use a personal login to manage API keys.", "usage");
    const json = flags.has("json");
    switch (sub) {
      case "create": {
        rejectUnknown(flags, ["name", "org", "expires", "json"]);
        const label = flags.get("name")?.trim();
        if (!label || id !== undefined) throw new AuthError(`Usage: ${createUsage}`, "usage");
        const expiry = serviceTokenExpiry.safeParse(flags.get("expires") ?? "30d");
        if (!expiry.success) throw new AuthError("Use --expires 30d, 90d, 1y, or never.", "usage");
        const api = await createArmadaApiClient(auth);
        const created = tokenOperations.createServiceToken.output.parse(
          await api.token("create", {
            org: flags.get("org"),
            label,
            expires: expiry.data,
          }),
        );
        auth.out(json ? `${JSON.stringify(created)}\n` : `${created.token}\n`);
        return 0;
      }
      case "ls": {
        rejectUnknown(flags, ["json"]);
        if (id !== undefined) throw new AuthError(`Usage: ${listUsage}`, "usage");
        const api = await createArmadaApiClient(auth);
        const result = tokenOperations.listServiceTokens.output.parse(await api.token("list"));
        if (json) auth.out(`${JSON.stringify(result)}\n`);
        else if (!result.tokens.length) auth.out("No API keys.\n");
        else {
          auth.out("ID  NAME  ORGANIZATION  CREATED  LAST USED  EXPIRES  REVOKED\n");
          for (const key of result.tokens) {
            auth.out(
              `${key.id}  ${key.label}  ${key.orgName}  ${key.createdAt}  ${key.lastUsedAt ?? "Never"}  ${key.expiresAt ?? "Never"}  ${key.revokedAt ?? "No"}\n`,
            );
          }
        }
        return 0;
      }
      case "revoke": {
        rejectUnknown(flags, ["json"]);
        if (!id || extra !== undefined) throw new AuthError(`Usage: ${revokeUsage}`, "usage");
        const api = await createArmadaApiClient(auth);
        await api.token("revoke", { id });
        auth.out(json ? '{"ok":true}\n' : `Revoked ${id}.\n`);
        return 0;
      }
      default:
        throw new AuthError("Run armada token create, ls, or revoke.", "usage");
    }
  },
} satisfies Command;
