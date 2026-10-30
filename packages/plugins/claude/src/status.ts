import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderConnection, ProviderStatus } from "@armada/plugin-api";
import { installation, loginCommand, probe } from "@armada/plugin-api/connection";

function plan(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/^claude/, "")
    .replace(/subscription$/, "")
    .replace(/plan$/, "");
  const labels: Record<string, string> = {
    max: "Max",
    max5: "Max 5x",
    max5x: "Max 5x",
    max20: "Max 20x",
    max20x: "Max 20x",
    pro: "Pro",
    free: "Free",
    team: "Team",
    enterprise: "Enterprise",
  };
  return labels[normalized] ? `Claude ${labels[normalized]}` : undefined;
}
export function claudeConnection(binary: string): ProviderConnection {
  return {
    async status(signal): Promise<ProviderStatus> {
      const installed = await installation(binary, signal);
      if (!installed.installed) return { ...installed, state: "missing" };
      const result = await probe(binary, ["auth", "status", "--json"], signal);
      let cli: Record<string, unknown> = {};
      try {
        cli = JSON.parse(result.output);
      } catch {
        /* Older CLIs rely on local metadata. */
      }
      let account: Record<string, unknown> = {};
      try {
        const root = process.env.CLAUDE_CONFIG_DIR;
        account =
          JSON.parse(await readFile(root ? join(root, ".claude.json") : join(homedir(), ".claude.json"), "utf8"))
            .oauthAccount ?? {};
      } catch {
        /* No saved account. */
      }
      signal?.throwIfAborted();
      if (cli.loggedIn === false || (cli.loggedIn !== true && !account.emailAddress && !account.email))
        return { ...installed, state: "disconnected" };
      const subscription = plan(
        cli.subscriptionType ??
          account.subscriptionType ??
          (account.hasExtraUsageEnabled ? undefined : account.billingType),
      );
      const email = cli.email ?? account.emailAddress ?? account.email;
      return {
        ...installed,
        state: "connected",
        account: {
          label: typeof email === "string" ? email : "Claude",
          ...(subscription ? { plan: subscription } : {}),
        },
      };
    },
    async connect(interaction) {
      const help = await probe(binary, ["auth", "login", "--help"], interaction.signal);
      if (help.ok) await loginCommand(binary, ["auth", "login"], interaction);
      else await loginCommand(binary, [], interaction);
    },
    async disconnect() {
      const result = await probe(binary, ["auth", "logout"]);
      if (!result.ok) throw new Error("Claude logout did not complete");
    },
  };
}
