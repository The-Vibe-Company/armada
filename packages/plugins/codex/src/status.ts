import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderConnection, ProviderStatus } from "@armada/plugin-api";
import { installation, loginCommand, probe } from "@armada/plugin-api/connection";

const plans: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro 100",
  promax: "Pro 500",
  team: "Team",
  business: "Business",
  self_serve_business_usage_based: "Business",
  enterprise: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  enterprise_cbp_automation: "Enterprise",
  ent26: "Enterprise",
  edu: "Edu",
  edu_plus: "Edu",
  edu_pro: "Edu",
};
export function codexConnection(binary: string): ProviderConnection {
  return {
    async status(signal): Promise<ProviderStatus> {
      const installed = await installation(binary, signal);
      if (!installed.installed) return { ...installed, state: "missing" };
      try {
        const auth = JSON.parse(
          await readFile(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"), "utf8"),
        );
        if (auth.tokens?.id_token) {
          const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split(".")[1], "base64url").toString("utf8"));
          const plan = plans[claims["https://api.openai.com/auth"]?.chatgpt_plan_type ?? claims.chatgpt_plan_type];
          return {
            ...installed,
            state: "connected",
            account: {
              label: typeof claims.email === "string" ? claims.email : "ChatGPT",
              ...(plan ? { plan: `ChatGPT ${plan}` } : {}),
            },
          };
        }
        if (auth.OPENAI_API_KEY) return { ...installed, state: "connected", account: { label: "OpenAI API key" } };
      } catch {
        /* A damaged or missing auth file falls back to the CLI's status. */
      }
      const auth = await probe(binary, ["login", "status"], signal);
      signal?.throwIfAborted();
      return {
        ...installed,
        state: auth.ok && /logged in|authenticated/i.test(auth.output) ? "connected" : "disconnected",
      };
    },
    connect: (interaction) => loginCommand(binary, ["login"], interaction),
    async disconnect() {
      const result = await probe(binary, ["logout"]);
      if (!result.ok) throw new Error("Codex logout did not complete");
    },
  };
}
