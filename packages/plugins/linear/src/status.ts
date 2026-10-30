import type { PluginContext, ProviderConnection, ProviderStatus } from "@armada/plugin-api";

export function linearConnection(
  secrets: PluginContext["secrets"],
  endpoint = "https://api.linear.app/graphql",
  request: (url: string, init: RequestInit) => Promise<Response> = (...args) => fetch(...args),
): ProviderConnection {
  async function viewer(key: string, signal?: AbortSignal) {
    const response = await request(endpoint, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query: "query ProviderViewer { viewer { name email organization { name } } }" }),
    });
    const body = (await response.json()) as {
      data?: { viewer?: { name?: string; email?: string; organization?: { name?: string } } };
      errors?: unknown[];
    };
    if (!response.ok || body.errors?.length || !body.data?.viewer?.name)
      throw new Error("Linear sign-in could not be verified");
    return body.data.viewer;
  }
  return {
    async status(signal): Promise<ProviderStatus> {
      try {
        const key = await secrets.get("LINEAR_API_KEY");
        if (!key) return { installed: true, state: "disconnected" };
        const account = await viewer(key, signal);
        return {
          installed: true,
          state: "connected",
          account: { label: `${account.name}${account.organization?.name ? ` (${account.organization.name})` : ""}` },
          detail: (await secrets.source?.("LINEAR_API_KEY")) ?? "API key",
        };
      } catch {
        signal?.throwIfAborted();
        return { installed: true, state: "disconnected", detail: "Linear connection could not be verified" };
      }
    },
    async connect(interaction) {
      interaction.signal?.throwIfAborted();
      if (await secrets.get("LINEAR_API_KEY")) return;
      const key = (await interaction.prompt({ type: "secret", message: "Linear API key" })).trim();
      if (!key || !/^[!-~]{1,8192}$/.test(key) || !secrets.set) throw new Error("Linear key could not be saved");
      await viewer(key, interaction.signal);
      interaction.signal?.throwIfAborted();
      await secrets.set("LINEAR_API_KEY", key);
    },
    async disconnect() {
      if (!secrets.delete) throw new Error("Credential storage unavailable");
      await secrets.delete("LINEAR_API_KEY");
    },
  };
}
