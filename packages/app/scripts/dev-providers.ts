// Synthetic providers for the dev daemon and the browser checks (THE-2075):
// three agents (two signed in, one not installed), a tracker that asks for
// its key, a forge whose sign-in prints a terminal, and this device's node,
// each booted as armadad boots a bundled plugin, with what they report kept in
// memory. No CLI runs, no network, no keychain: invented accounts only.

import { bootDaemon } from "@armada/daemon";
import { Keychain } from "@armada/daemon/keychain";
import type { PluginCatalogEntry } from "@armada/daemon/plugins/catalog";
import { Providers } from "../../daemon/src/server/providers.ts";
import type { AuthInteraction, PluginContext, ProviderStatus, RuntimeProvider } from "../../plugin-api/src/index.ts";

type Seam = "runtime" | "tracker" | "forge" | "node";

/** One synthetic provider: its plugin's manifest, and its connection as it stands. */
interface Fake {
  id: string;
  seam: Seam;
  description: string;
  config?: Record<string, unknown>;
  status: ProviderStatus;
  /** Signs in: asks and prints what a real one would, then reads as `signedIn`. */
  connect?: (interaction: AuthInteraction) => Promise<void>;
  signedIn?: ProviderStatus;
}

const runtimeConfig = {
  type: "object",
  properties: {
    command: { type: "string", minLength: 1 },
    binary: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

function fakes(): Fake[] {
  const signedOut = { installed: true, state: "disconnected" } as const;
  return [
    {
      id: "codex",
      seam: "runtime",
      description: "Run the codex CLI",
      config: runtimeConfig,
      status: {
        installed: true,
        version: "0.166.0",
        state: "connected",
        account: { label: "ada@example.test", plan: "ChatGPT Pro" },
      },
    },
    {
      id: "claude",
      seam: "runtime",
      description: "Run the claude CLI",
      config: runtimeConfig,
      status: {
        installed: true,
        version: "2.1.314",
        state: "connected",
        account: { label: "ada@example.test", plan: "Claude Max" },
      },
    },
    {
      id: "opencode",
      seam: "runtime",
      description: "Run the opencode CLI",
      config: runtimeConfig,
      status: { installed: false, state: "missing", detail: "Install it with npm i -g opencode-ai" },
    },
    {
      id: "linear",
      seam: "tracker",
      description: "Read tickets from Linear",
      status: signedOut,
      async connect(interaction) {
        const key = await interaction.prompt({ type: "secret", message: "Linear API key" });
        if (!key.trim()) throw new Error("Linear key could not be saved");
      },
      signedIn: {
        installed: true,
        state: "connected",
        account: { label: "Ada Lindqvist (Harbor)" },
        detail: "Saved key",
      },
    },
    {
      id: "github",
      seam: "forge",
      description: "Read pull requests from GitHub",
      status: {
        installed: true,
        version: "2.80.0",
        state: "connected",
        account: { label: "ada-lindqvist" },
        detail: "gh",
      },
      async connect(interaction) {
        interaction.notify({
          type: "terminal",
          output: "\u001b[1m! First copy your one-time code: QX7R-2KD9\u001b[0m\r\n",
        });
        interaction.notify({
          type: "device_code",
          userCode: "QX7R-2KD9",
          verificationUri: "https://github.com/login/device",
        });
        interaction.notify({ type: "terminal", output: "Press Enter to open github.com in your browser...\r\n" });
        await interaction.prompt({ type: "text", message: "Press Enter in the terminal", placeholder: "Enter" });
        interaction.notify({
          type: "terminal",
          output: "✓ Authentication complete.\r\n✓ Logged in as ada-lindqvist\r\n",
        });
      },
      signedIn: { installed: true, state: "connected", account: { label: "ada-lindqvist" }, detail: "gh" },
    },
    {
      id: "node-local",
      seam: "node",
      description: "Sessions on this device",
      status: { installed: true, state: "connected" },
    },
  ];
}

/** The catalog armadad would load, from the fakes; `id` and `mark` are the real plugins' so their marks show. */
export function devProviderCatalog(): PluginCatalogEntry[] {
  return fakes().map((fake) => {
    let status = fake.status;
    const connection = {
      status: async () => status,
      ...(fake.connect
        ? {
            async connect(interaction: AuthInteraction) {
              await fake.connect?.(interaction);
              status = fake.signedIn ?? { ...status, state: "connected" };
            },
          }
        : {}),
      async disconnect() {
        status = { installed: status.installed, state: status.installed ? "disconnected" : "missing" };
      },
    };
    const manifest = {
      id: fake.id,
      version: "0.1.0",
      pluginApi: "^0.2.0",
      enabledByDefault: true,
      description: fake.description,
      contributions: { [fake.seam]: { [fake.id]: { config: fake.config ?? { type: "object" }, secrets: [] } } },
    };
    return {
      id: fake.id,
      manifest,
      load: async () => ({
        activate(ctx: PluginContext) {
          const refuse = async () => {
            throw new Error("A synthetic provider runs no work");
          };
          if (fake.seam === "runtime")
            ctx.register.runtime(fake.id, {
              ...connection,
              prepare: refuse,
              launch: refuse,
              deliver: refuse,
              observe: refuse,
              stop: refuse,
            } as RuntimeProvider);
          else if (fake.seam === "node") ctx.register.node(fake.id, { ...connection } as never);
          else
            ctx.register[fake.seam](fake.id, {
              ...connection,
              read: async () => {},
              write: async () => {},
              merge: refuse,
            } as never);
        },
      }),
    };
  });
}

/** A booted daemon on the synthetic catalog, and what `startServer` needs to serve its plugins and providers. */
export async function bootDevProviders(configPath: string) {
  const entries = new Map<string, string>();
  const keychain = new Keychain({
    storage: "os-keychain",
    read: async (service, account) => entries.get(`${service}/${account}`) ?? null,
    write: async (service, account, value) => {
      entries.set(`${service}/${account}`, value);
    },
  });
  const catalog = devProviderCatalog();
  const daemon = await bootDaemon({
    databasePath: ":memory:",
    configPath,
    catalog,
    secrets: { get: async () => null },
    log: { info() {}, error() {} },
  });
  const host = { configPath, catalog: daemon.catalog, boot: daemon, keychain };
  const providers = new Providers({ ...host, registry: daemon.registry });
  return {
    plugins: host,
    providers,
    close() {
      providers.close();
      daemon.close();
    },
  };
}
