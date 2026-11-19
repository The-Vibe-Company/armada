import { AuthError, assertProvider } from "@armada/auth";
import { loginCommand } from "../auth-commands.ts";
import { authFlag, parseAuth, rejectUnknown } from "./auth-args.ts";
import type { Command } from "./command.ts";

export default {
  name: "login",
  summary: "Sign in to Armada",
  usage: {
    session: `  armada login [--url <url>] [--provider github|google | --email <address>]
                                           Discovers enabled methods; prompts for email when available.
                                           --email: open the emailed link on this machine, or type its code (use one, not both)`,
  },
  help: `Usage: armada login [--json] [--email <address> | --provider github|google] [--url <server-origin>]
Sign in to Armada, not directly to a sandbox provider.
Use --email for email code/link sign-in; --provider chooses an enabled browser method.
Do not combine --email and --provider. Without either, discover enabled server methods.
Server selection: --url, then ARMADA_URL, then the default Armada API origin.
Global --profile NAME (or ARMADA_PROFILE) isolates saved login and preferences;
use login --url to configure a new profile's server.
Keep the terminal open while completing sign-in. Use an interactive terminal for email code entry.
ARMADA_TOKEN supplies service-token authentication to API commands; a saved login
does not unset that environment variable. Keep tokens in a secure environment, never arguments.
--json returns {authenticated:true} on success; progress remains on stderr.
Example: armada login --email you@example.com
Example: armada --profile staging login --url https://staging.example.com --provider github
`,
  completionBefore: "snapshot",
  useSelectedOrg: false,
  async run(argv, { auth }) {
    const parsed = parseAuth(argv);
    rejectUnknown(parsed.flags, ["provider", "email", "url", "json"]);
    if (parsed.position.length > 0) throw new AuthError("Run armada login --help.", "usage");
    if (parsed.flags.has("provider") && parsed.flags.has("email")) {
      throw new AuthError("Use --provider or --email, not both.", "usage");
    }
    const provider = parsed.flags.has("provider") ? assertProvider(authFlag(parsed.flags, "provider")) : undefined;
    const email = parsed.flags.has("email") ? authFlag(parsed.flags, "email") : undefined;
    await loginCommand(auth, {
      provider,
      email,
      url: parsed.flags.get("url"),
      json: parsed.flags.has("json"),
    });
    return 0;
  },
} satisfies Command;
