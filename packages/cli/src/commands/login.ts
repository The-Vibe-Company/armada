import { AuthError } from "@armada/auth";
import { loginCommand } from "../auth-commands.ts";
import { authFlag, parseAuth, rejectUnknown } from "./auth-args.ts";
import type { Command } from "./command.ts";

export default {
  name: "login",
  summary: "Sign in to Armada",
  usage: {
    session: "  armada login [--url <url>] [--org NAME|UUID|none]        Sign in and authorize the CLI in your browser",
  },
  help: `Usage: armada login [--json] [--url <server-origin>] [--org NAME|UUID|none]
Open the dashboard link, sign in there and authorize the CLI. The browser can
be on a different machine. Keep the terminal open until it confirms sign-in.
Server selection: --url, then ARMADA_URL, then the saved login server or the default Armada API origin.
--org saves a default organization by exact name or UUID after authorization.
Use --org none to clear it. Omit --org to keep the saved selection.
Global --profile NAME (or ARMADA_PROFILE) isolates saved login and preferences;
use login --url to configure a new profile's server.
ARMADA_TOKEN supplies service-token authentication to API commands; a saved login
does not unset that environment variable. Keep tokens in a secure environment, never arguments.
--json writes {verificationUrl,userCode,expiresAt} immediately, then
{authenticated:true} after authorization. Open the link on any machine.
Example: armada --profile staging login --url https://staging.example.com
`,
  useSelectedOrg: false,
  async run(argv, { auth }) {
    const parsed = parseAuth(argv);
    rejectUnknown(parsed.flags, ["url", "org", "json"]);
    if (parsed.position.length > 0) throw new AuthError("Run armada login --help.", "usage");
    await loginCommand(auth, {
      url: parsed.flags.has("url") ? authFlag(parsed.flags, "url") : undefined,
      org: parsed.flags.has("org") ? authFlag(parsed.flags, "org") : undefined,
      json: parsed.flags.has("json"),
    });
    return 0;
  },
} satisfies Command;
