import type { ProviderConnection, ProviderStatus } from "@armada/plugin-api";
import { installation, loginCommand, probe, publicText } from "@armada/plugin-api/connection";
export function opencodeConnection(binary: string): ProviderConnection {
  return {
    async status(signal): Promise<ProviderStatus> {
      const installed = await installation(binary, signal);
      if (!installed.installed) return { ...installed, state: "missing" };
      const auth = await probe(binary, ["auth", "list"], signal);
      signal?.throwIfAborted();
      const text = publicText(auth.output);
      const count = text.match(/\b(\d+) credentials?\b/i);
      const connected = auth.ok && (count ? Number(count[1]) > 0 : /(?:OAuth|API key|✓)/i.test(text));
      return {
        ...installed,
        state: connected ? "connected" : "disconnected",
        ...(connected ? { account: { label: "OpenCode" } } : {}),
      };
    },
    connect: (interaction) => loginCommand(binary, ["auth", "login"], interaction),
    disconnect: () =>
      loginCommand(binary, ["auth", "logout"], {
        notify() {},
        prompt: async () => {
          throw new Error("Use OpenCode to choose the account to disconnect");
        },
      }),
  };
}
