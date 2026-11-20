import { AuthError } from "@armada/auth";
import { tokenOperations } from "@armada/core/contract/tokens";
import { createArmadaApiClient } from "../armada-api.ts";
import { parseAuth, rejectUnknown } from "./auth-args.ts";
import type { Command } from "./command.ts";

export default {
  name: "whoami",
  summary: "Show the current Armada login or API key",
  usage: { session: "  armada whoami [--json]" },
  help: "Usage: armada whoami [--json]\nShow the verified login or API key identity.\n",
  async run(argv, { auth }) {
    const { position, flags } = parseAuth(argv);
    rejectUnknown(flags, ["json"]);
    if (position.length) throw new AuthError("Usage: armada whoami [--json]", "usage");
    const api = await createArmadaApiClient(auth);
    const result = tokenOperations.whoami.output.parse(
      await api.request(tokenOperations.whoami.route.path, { method: tokenOperations.whoami.route.method }),
    );
    if (flags.has("json")) auth.out(`${JSON.stringify(result)}\n`);
    else if (result.auth === "key")
      auth.out(`${result.userId} (API key ${result.key.name}, expires ${result.key.expiresAt ?? "never"})\n`);
    else auth.out(`${result.userId} (saved login)\n`);
    return 0;
  },
} satisfies Command;
