import type { AuthInteraction, PluginContext, ProviderConnection, ProviderStatus, Seam } from "@armada/plugin-api";
import { manifestSchema, SEAMS } from "@armada/plugin-api";
import { publicText, publicUrl } from "@armada/plugin-api/connection";
import { type Provider, providerSchema } from "@armada/protocol";
import { readPluginSettings } from "../plugins/config.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { PluginHost } from "./plugins.ts";

export interface ProvidersHost extends PluginHost {
  registry: PluginRegistry;
  secrets?: PluginContext["secrets"];
}
export interface ProviderClock {
  schedule(run: () => void, ms: number): () => void;
}
const names: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  opencode: "OpenCode",
  linear: "Linear",
  github: "GitHub",
  "model-anthropic": "Anthropic",
  "model-openai-compatible": "OpenAI compatible",
  "node-local": "This device",
};
const order = { agent: 0, tracker: 1, forge: 2, model: 3, node: 4 };
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

/** Owner-facing provider catalog. Connection output is ephemeral, never appended to the event log. */
export class Providers {
  private readonly host: ProvidersHost;
  private readonly listeners = new Set<(providers: Provider[]) => void>();
  private readonly controller = new AbortController();
  private refreshing?: Promise<Provider[]>;
  private current: Provider[] = [];
  private cancelTimer?: () => void;
  private readonly clock: ProviderClock;
  private secrets: string[] = [];
  /** Never return a credential, even if a provider put it in a public field. */
  text(value: string, account = false): string {
    let safe = value;
    for (const secret of this.secrets) if (secret) safe = safe.split(secret).join("[redacted]");
    return publicText(safe, [], account);
  }
  constructor(
    host: ProvidersHost,
    clock: ProviderClock = {
      schedule(run, ms) {
        const timer = setTimeout(run, ms);
        timer.unref();
        return () => clearTimeout(timer);
      },
    },
  ) {
    this.host = host;
    this.clock = clock;
    this.schedule();
  }
  private schedule() {
    if (this.controller.signal.aborted) return;
    this.cancelTimer = this.clock.schedule(() => {
      void this.refresh()
        .catch(() => {})
        .finally(() => this.schedule());
    }, 5 * 60_000);
  }
  subscribe(listener: (providers: Provider[]) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private entries() {
    return this.host.catalog.flatMap((entry) => {
      const parsed = manifestSchema.safeParse(entry.manifest);
      if (!parsed.success) return [];
      const contributions = SEAMS.flatMap((seam) =>
        Object.keys(parsed.data.contributions[seam] ?? {}).map((kind) => ({ seam, kind })),
      );
      return contributions.map(({ seam, kind }) => ({
        id: contributions.length === 1 ? entry.id : `${entry.id}/${kind}`,
        plugin: entry.id,
        manifest: parsed.data,
        seam,
        kind,
      }));
    });
  }
  async refresh(force = false): Promise<Provider[]> {
    if (this.controller.signal.aborted) return this.current;
    if (force && this.refreshing) await this.refreshing.catch(() => {});
    if (this.controller.signal.aborted) return this.current;
    this.refreshing ??= this.read().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  private async read(): Promise<Provider[]> {
    const settings = await readPluginSettings(this.host.configPath);
    const secretNames = new Set(
      this.entries().flatMap((entry) => entry.manifest.contributions[entry.seam]?.[entry.kind]?.secrets ?? []),
    );
    this.secrets = (
      await Promise.all(
        [...secretNames].flatMap((name) => [
          this.host.keychain.read("plugin", name).catch(() => null),
          this.host.secrets?.get(name).catch(() => null) ?? Promise.resolve(null),
        ]),
      )
    ).filter((value): value is string => !!value);
    if (this.controller.signal.aborted) return this.current;
    const next = await Promise.all(
      this.entries().map(async (entry): Promise<Provider> => {
        const setting = settings.find((s) => s.id === entry.plugin);
        const booted = this.host.boot.settings.find((s) => s.id === entry.plugin);
        const boot = this.host.boot.plugins.find((p) => p.id === entry.plugin);
        const enabled = setting?.enabled ?? entry.manifest.enabledByDefault;
        const restartRequired =
          !boot ||
          boot.enabled !== enabled ||
          (enabled && canonical(setting?.config ?? {}) !== canonical(booted?.config ?? {}));
        const provider = this.host.registry.get(entry.seam, entry.kind) as ProviderConnection | undefined;
        let status: ProviderStatus = {
          installed: true,
          state: "disconnected",
          detail: restartRequired ? "Restart required" : "Connect to use this provider",
        };
        if (provider?.status) {
          const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]);
          try {
            signal.throwIfAborted();
            status = await Promise.race([
              provider.status(signal),
              new Promise<never>((_resolve, reject) =>
                signal.aborted
                  ? reject(new Error("Status unavailable"))
                  : signal.addEventListener("abort", () => reject(new Error("Status unavailable")), { once: true }),
              ),
            ]);
          } catch {
            status = { installed: true, state: "disconnected", detail: "Connection status unavailable" };
          }
        } else if (entry.seam === "node" && provider) status = { installed: true, state: "connected" };
        const raw = setting?.config[entry.seam]?.[entry.kind];
        const config = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
        const binary =
          entry.seam === "runtime"
            ? typeof config.binary === "string"
              ? config.binary
              : typeof config.command === "string"
                ? config.command
                : entry.kind
            : undefined;
        const routing = Object.fromEntries(
          ["model", "effort"].flatMap((key) =>
            typeof config[key] === "string" ? [[key, this.text(config[key] as string)]] : [],
          ),
        );
        return providerSchema.parse({
          id: entry.id,
          seam: entry.seam === "runtime" ? "agent" : entry.seam,
          name: names[entry.plugin] ?? entry.kind,
          mark: entry.plugin,
          ...(status.version ? { version: this.text(status.version) } : {}),
          state: !status.installed ? "missing" : status.state,
          ...(status.account
            ? {
                account: {
                  label: this.text(status.account.label, true),
                  ...(status.account.plan ? { plan: this.text(status.account.plan) } : {}),
                },
              }
            : {}),
          ...(status.detail ? { detail: this.text(status.detail) } : {}),
          enabled,
          config: {
            ...(binary ? { binary: this.text(binary) } : {}),
            ...(Object.keys(routing).length ? { routing } : {}),
          },
          restartRequired,
        });
      }),
    );
    next.sort((a, b) => order[a.seam] - order[b.seam] || a.name.localeCompare(b.name));
    if (!this.controller.signal.aborted && canonical(next) !== canonical(this.current)) {
      this.current = next;
      for (const listener of this.listeners) listener(next);
    }
    return next;
  }
  private async provider(id: string): Promise<ProviderConnection> {
    const entry = this.entries().find((e) => e.id === id);
    if (!entry) throw new Error("Unknown provider");
    const settings = await readPluginSettings(this.host.configPath);
    if (!(settings.find((s) => s.id === entry.plugin)?.enabled ?? entry.manifest.enabledByDefault))
      throw new Error("Enable this provider before connecting");
    const provider = this.host.registry.get(entry.seam as Seam, entry.kind);
    if (!provider) throw new Error("Restart Armada to use this provider");
    return provider as ProviderConnection;
  }
  async connect(id: string, interaction: AuthInteraction) {
    await this.refresh(true);
    interaction.signal?.throwIfAborted();
    const provider = await this.provider(id);
    if (!provider.connect) throw new Error("This provider does not support app sign-in");
    const entered: string[] = [];
    const text = (value: string) => publicText(this.text(value), entered);
    await provider.connect({
      signal: interaction.signal,
      prompt: async (prompt) => {
        const safe =
          prompt.type === "select"
            ? {
                ...prompt,
                message: text(prompt.message),
                options: prompt.options.map((option) => ({
                  id: text(option.id),
                  label: text(option.label),
                  ...(option.description ? { description: text(option.description) } : {}),
                })),
              }
            : {
                ...prompt,
                message: text(prompt.message),
                ...(prompt.placeholder ? { placeholder: text(prompt.placeholder) } : {}),
              };
        const answer = await interaction.prompt(safe);
        entered.push(answer);
        return answer;
      },
      notify: (event) => {
        switch (event.type) {
          case "terminal":
            interaction.notify({ type: event.type, output: text(event.output) });
            break;
          case "auth_url": {
            const url = publicUrl(text(event.url));
            if (url)
              interaction.notify({
                type: event.type,
                url,
                ...(event.instructions ? { instructions: text(event.instructions) } : {}),
              });
            break;
          }
          case "device_code":
            interaction.notify({
              type: event.type,
              userCode: text(event.userCode),
              verificationUri: text(event.verificationUri),
              ...(event.intervalSeconds ? { intervalSeconds: event.intervalSeconds } : {}),
              ...(event.expiresInSeconds ? { expiresInSeconds: event.expiresInSeconds } : {}),
            });
            break;
          case "info":
            interaction.notify({
              type: event.type,
              message: text(event.message),
              ...(event.links
                ? {
                    links: event.links.map((link) => ({
                      url: text(link.url),
                      ...(link.label ? { label: text(link.label) } : {}),
                    })),
                  }
                : {}),
            });
            break;
          case "progress":
            interaction.notify({ type: event.type, message: text(event.message) });
            break;
        }
      },
    });
    interaction.signal?.throwIfAborted();
    await this.refresh(true);
  }
  async disconnect(id: string) {
    const provider = await this.provider(id);
    if (!provider.disconnect) throw new Error("This provider does not support app sign-out");
    await provider.disconnect();
    await this.refresh(true);
  }
  close() {
    this.controller.abort();
    this.cancelTimer?.();
    this.listeners.clear();
  }
}
