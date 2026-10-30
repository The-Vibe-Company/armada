import type { PluginContext, ProviderConnection, ProviderStatus } from "@armada/plugin-api";
import { installation, loginCommand, probe } from "@armada/plugin-api/connection";

export function githubConnection(
  secrets: PluginContext["secrets"],
  endpoint = "https://api.github.com",
  request: (url: string, init: RequestInit) => Promise<Response> = (...args) => fetch(...args),
): ProviderConnection {
  async function credential(signal?: AbortSignal) {
    const key = await secrets.get("GITHUB_TOKEN");
    if (key) return { key, source: (await secrets.source?.("GITHUB_TOKEN")) ?? "API key" };
    const gh = await probe("gh", ["auth", "token"], signal);
    return gh.ok && gh.output && !/\s/.test(gh.output) ? { key: gh.output, source: "gh" } : null;
  }
  async function viewer(key: string, signal?: AbortSignal): Promise<string> {
    const response = await request(`${endpoint.replace(/\/graphql\/?$/, "").replace(/\/$/, "")}/user`, {
      redirect: "error",
      signal,
      headers: { Authorization: `Bearer ${key}`, Accept: "application/vnd.github+json" },
    });
    const body = (await response.json()) as { login?: unknown };
    if (!response.ok || typeof body.login !== "string" || !/^[a-zA-Z0-9-]+$/.test(body.login))
      throw new Error("GitHub sign-in could not be verified");
    return body.login;
  }
  return {
    async status(signal): Promise<ProviderStatus> {
      try {
        const auth = await credential(signal);
        if (!auth) return { installed: true, state: "disconnected" };
        const login = await viewer(auth.key, signal);
        return { installed: true, state: "connected", account: { label: `${login} (${auth.source})` } };
      } catch {
        signal?.throwIfAborted();
        return { installed: true, state: "disconnected", detail: "GitHub connection could not be verified" };
      }
    },
    async connect(interaction) {
      interaction.signal?.throwIfAborted();
      if (await credential(interaction.signal)) return;
      if ((await installation("gh", interaction.signal)).installed) {
        await loginCommand(
          "gh",
          ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"],
          interaction,
        );
        return;
      }
      const key = (await interaction.prompt({ type: "secret", message: "GitHub token" })).trim();
      if (!key || !/^[!-~]{1,8192}$/.test(key) || !secrets.set) throw new Error("GitHub token could not be saved");
      await viewer(key, interaction.signal);
      interaction.signal?.throwIfAborted();
      await secrets.set("GITHUB_TOKEN", key);
    },
    async disconnect() {
      if (!secrets.delete) throw new Error("Credential storage unavailable");
      await secrets.delete("GITHUB_TOKEN");
      const source = await secrets.source?.("GITHUB_TOKEN");
      if (source === "gh" || (!source && !(await secrets.get("GITHUB_TOKEN")))) {
        const result = await probe("gh", ["auth", "logout", "--hostname", "github.com"]);
        if (!result.ok && !result.missing) throw new Error("GitHub logout did not complete");
      }
    },
  };
}
