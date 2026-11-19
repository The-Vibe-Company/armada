import { AuthError } from "@armada/auth";
import { tokenCreate, tokenList, tokenRevoke } from "../auth-commands.ts";
import { parseAuth, rejectUnknown } from "./auth-args.ts";
import type { Command } from "./command.ts";

export default {
  name: "token",
  summary: "Manage service tokens",
  usage: {
    session: `  armada token create [--org <name>] [--label <label>]
  armada token list
  armada token revoke <id>`,
  },
  help: `Usage: armada token <command> [arguments]
Manage Armada service tokens for authenticated scripts, not model/provider keys.
Use leaf --help/-h for exact flags and server authorization requirements.
  create  Create a token; stdout contains the secret even with --json.
  list    List metadata, IDs and revocation state, never secret values.
  revoke  Revoke using the token ID from list, not the secret value.
Store new tokens securely when printed; Armada stores only their hashes.
Never commit tokens or send creation output to public logs.
Supply ARMADA_TOKEN through a secure environment, never command arguments.
Help does not create, list or revoke tokens.
Example: armada token list --json
Example: armada token create --help
`,
  subcommandHelp: {
    "token create": `Usage: armada token create [--org <name>] [--label <label>] [--json]
Create a service token with authenticated access and server authorization.
An explicit --org overrides a saved organization selection.
Warning: stdout contains the new secret, including with --json. Store it securely now;
Armada stores only its hash. Never commit it or send output to public logs.
Supply the token to scripts using ARMADA_TOKEN through a secure environment, not arguments.
Example: armada token create --org my-team --label automation
`,
    "token list": `Usage: armada token list [--json]
List service-token metadata with authenticated access and server authorization.
Output includes IDs and revocation state, not token values. Use an ID with token revoke.
Example: armada token list --json
`,
    "token revoke": `Usage: armada token revoke <id> [--json]
Revoke a service token with authenticated access and server authorization.
Use its ID from armada token list --json, never the secret token value.
Example: armada token revoke TOKEN_UUID
`,
  },
  helpWhenBare: true,
  useSelectedOrg: (argv) => argv[0] === "create",
  async run(argv, { auth }) {
    const parsed = parseAuth(argv);
    const sub = parsed.position[0];
    const extra = parsed.position[1];
    switch (sub) {
      case "create":
        rejectUnknown(parsed.flags, ["org", "label", "json"]);
        if (extra !== undefined) throw new AuthError("Run armada token create --org <name> --label <label>.", "usage");
        await tokenCreate(auth, parsed.flags.get("org"), parsed.flags.get("label"), parsed.flags.has("json"));
        return 0;
      case "list":
        rejectUnknown(parsed.flags, ["json"]);
        if (extra !== undefined) throw new AuthError("Run armada token list.", "usage");
        await tokenList(auth, parsed.flags.has("json"));
        return 0;
      case "revoke":
        rejectUnknown(parsed.flags, ["json"]);
        if (!extra || parsed.position.length > 2) throw new AuthError("Run armada token revoke <id>.", "usage");
        await tokenRevoke(auth, extra, parsed.flags.has("json"));
        return 0;
      default:
        throw new AuthError("Run armada token create, list, or revoke.", "usage");
    }
  },
} satisfies Command;
