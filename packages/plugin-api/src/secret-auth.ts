import type { ProviderConnection } from "./connection.js";
import type { PluginContext } from "./index.js";

/** Optional connection capability for custom model endpoints using one declared API key. */
export function secretConnection(
  secrets: PluginContext["secrets"],
  name: string | null,
  label: string,
  changed: (key: string | null) => void,
): ProviderConnection {
  return {
    async status(signal) {
      signal?.throwIfAborted();
      const connected = name === null || !!(await secrets.get(name));
      return {
        installed: true,
        state: connected ? "connected" : "disconnected",
        ...(connected ? { account: { label } } : {}),
      };
    },
    async connect(interaction) {
      if (name === null) return;
      const existing = await secrets.get(name);
      if (existing) {
        changed(existing);
        return;
      }
      const key = (await interaction.prompt({ type: "secret", message: `${label} API key` })).trim();
      interaction.signal?.throwIfAborted();
      if (!key || !/^[!-~]{1,8192}$/.test(key) || !secrets.set) throw new Error("Model key could not be saved");
      await secrets.set(name, key);
      changed(key);
    },
    async disconnect() {
      if (name === null) return;
      if (!secrets.delete) throw new Error("Credential storage unavailable");
      await secrets.delete(name);
      changed(await secrets.get(name));
    },
  };
}
