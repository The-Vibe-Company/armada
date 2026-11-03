// Settings › Providers and Connections' rules (THE-2075), pure: which cards
// show, each card's status line on its dot, the version as a card reads it,
// what the binary path saves, and the routing rules that send work to an agent.
import { type Json, type Plugin, type Provider, rulesStateSchema } from "@armada/protocol";

/** A status line on its dot: its words, the dot's colour and the words' ink. */
export interface StatusLine {
  word: string;
  dot: string;
  ink: string;
  /** What the daemon adds: an install hint, where the key comes from. */
  detail?: string;
}

const GREEN = { dot: "bg-green", ink: "text-text-2" };
const QUIET = { dot: "bg-text-3", ink: "text-text-3" };
const AMBER = { dot: "bg-amber", ink: "text-amber" };

/** The agents' cards: the catalog's agents, in the daemon's order. */
export const agentCards = (providers: readonly Provider[]) => providers.filter((p) => p.seam === "agent");

/** An agent's line: "Authenticated · ChatGPT Pro", "Authenticated as …", "Not signed in", "Not installed". */
export function agentStatus(provider: Provider): StatusLine {
  if (provider.state === "missing")
    return { word: "Not installed", ...AMBER, ...(provider.detail ? { detail: provider.detail } : {}) };
  if (provider.state === "disconnected") return { word: "Not signed in", ...QUIET };
  const account = provider.account;
  const word = account?.plan
    ? `Authenticated · ${account.plan}`
    : account
      ? `Authenticated as ${account.label}`
      : "Authenticated";
  return { word, ...GREEN };
}

/** A connection's line: "Connected as Stan", "Not connected", "Not installed". */
export function connectionStatus(provider: Provider | undefined): StatusLine {
  if (!provider) return { word: "Not available in this build", ...QUIET };
  if (provider.state === "missing")
    return { word: "Not installed", ...AMBER, ...(provider.detail ? { detail: provider.detail } : {}) };
  if (provider.state === "disconnected") return { word: "Not connected", ...QUIET };
  const source = sourceLabel(provider.detail);
  return {
    word: provider.account ? `Connected as ${provider.account.label}` : "Connected",
    ...GREEN,
    ...(source ? { detail: source } : {}),
  };
}

/** Where a connection's key comes from, as the daemon names it (connection-secrets.ts), in words. */
export function sourceLabel(detail: string | undefined): string | undefined {
  switch (detail) {
    case "Armada":
      return "From Armada";
    case "Environment":
      return "From the environment";
    case "gh":
      return "gh CLI";
    default:
      return detail;
  }
}

/** A CLI's version as the card shows it: `v0.166.0`, or what the CLI said when it is not a bare number. */
export function versionLabel(version: string | undefined): string | null {
  const v = version?.trim();
  if (!v) return null;
  return /^\d/.test(v) ? `v${v}` : v;
}

/** The provider's plugin and runtime kind: an id is `plugin` or `plugin/kind` (several contributions). */
export function runtimeOf(provider: Provider, plugins: readonly Plugin[]): { plugin: string; kind: string } | null {
  const plugin = plugins.find((p) => p.id === provider.mark);
  const [, named] = provider.id.split("/");
  const runtimes = plugin?.contributions.filter((c) => c.seam === "runtime") ?? [];
  const kind = named ?? (runtimes.length === 1 ? runtimes[0]?.kind : undefined);
  return plugin && kind && runtimes.some((c) => c.kind === kind) ? { plugin: plugin.id, kind } : null;
}

/**
 * The config `plugins.configure` saves for a new binary path: the saved
 * config kept, `binary` set, or left out when the field is empty (the
 * agent's own command again). The older `command` key says the same (the
 * agents read `binary ?? command`): it gives way to the field.
 */
export function binaryConfig(plugin: Plugin, kind: string, binary: string): { [key: string]: Json } {
  const saved = plugin.contributions.find((c) => c.seam === "runtime" && c.kind === kind)?.config;
  const {
    binary: _old,
    command: _alias,
    ...rest
  }: { [key: string]: Json } = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const value = binary.trim();
  return value ? { ...rest, binary: value } : rest;
}

/** One rule that sends work to an agent: its project, its labels or condition, the model it picks. */
export interface Route {
  project: string;
  projectName: string;
  /** The ticket's labels, a condition in words, or null for the project's default route. */
  labels: string[] | null;
  when: string | null;
  model: string;
  effort: string | null;
}

/** The projects' rules (their folded state's `rules`) that route to this agent's CLI, in each project's order. */
export function routesTo(
  cli: string,
  projects: readonly { id: string; name: string }[],
  fleets: Readonly<Record<string, { state?: unknown } | undefined>>,
): Route[] {
  return projects.flatMap((project) => {
    const state = fleets[project.id]?.state;
    const raw = state && typeof state === "object" ? Reflect.get(state, "rules") : undefined;
    const parsed = rulesStateSchema.safeParse(raw);
    if (!parsed.success) return [];
    const { routing = [], defaultRoute } = parsed.data.value;
    const base = { project: project.id, projectName: project.name };
    const routes: Route[] = routing
      .filter((r) => r.cli === cli)
      .map((r) => ({
        ...base,
        labels: "labels" in r ? r.labels : null,
        when: "when" in r ? r.when : null,
        model: r.model,
        effort: r.effort ?? null,
      }));
    if (defaultRoute?.cli === cli)
      routes.push({
        ...base,
        labels: null,
        when: null,
        model: defaultRoute.model,
        effort: defaultRoute.effort ?? null,
      });
    return routes;
  });
}

const PERMISSION_MODES: Record<string, { initial: string; choices: [string, string][] }> = {
  claude: {
    initial: "bypassPermissions",
    choices: [
      ["bypassPermissions", "Unattended"],
      ["acceptEdits", "Accept edits"],
      ["default", "CLI default"],
    ],
  },
  codex: {
    initial: "workspace-write",
    choices: [
      ["workspace-write", "Unattended · workspace write"],
      ["read-only", "Unattended · read only"],
      ["default", "CLI default"],
    ],
  },
  opencode: {
    initial: "allow",
    choices: [
      ["allow", "Unattended"],
      ["ask", "Ask for permission"],
      ["deny", "Deny tools"],
      ["default", "CLI default"],
    ],
  },
};
const permissionFlag =
  /^(?:--permission-mode|--dangerously-skip-permissions|--ask-for-approval|--sandbox|--full-auto|--approve-for-me|--dangerously-bypass-approvals-and-sandbox)(?:=|$)|^-[as](?:$|=|never|on-request|untrusted|on-failure|workspace-write|read-only|danger-full-access)/;
const permissionSetting =
  /^(?:(?:--config=|-c))?(?:approval_policy|sandbox_mode|sandbox_workspace_write\.network_access)\s*=/;
const savedRuntime = (plugin: Plugin, kind: string): { [key: string]: Json } => {
  const value = plugin.contributions.find((c) => c.seam === "runtime" && c.kind === kind)?.config;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
};

/** Show custom argv truthfully; the selector deliberately replaces only permission overrides. */
export function runtimePermission(provider: Provider, plugins: readonly Plugin[]) {
  const runtime = runtimeOf(provider, plugins);
  const modes = runtime && PERMISSION_MODES[runtime.kind];
  const plugin = runtime && plugins.find((p) => p.id === runtime.plugin);
  if (!runtime || !modes || !plugin) return null;
  const config = savedRuntime(plugin, runtime.kind);
  const args = config.args ?? config.extraArgs;
  const custom =
    Array.isArray(args) &&
    args.some((a) => typeof a === "string" && (permissionFlag.test(a) || permissionSetting.test(a)));
  const value = custom ? "custom" : typeof config.permissionMode === "string" ? config.permissionMode : modes.initial;
  return {
    ...runtime,
    ...modes,
    value,
    summary: custom
      ? "Permissions set by custom arguments"
      : value === modes.initial
        ? "Runs unattended in its worktree"
        : value === "read-only"
          ? "Runs unattended with read-only tools"
          : value === "default"
            ? "Uses the CLI's permission settings"
            : `Permission mode: ${value}`,
  };
}

export function permissionConfig(plugin: Plugin, kind: string, permissionMode: string): { [key: string]: Json } {
  const config: { [key: string]: Json } = { ...savedRuntime(plugin, kind), permissionMode };
  for (const key of ["args", "extraArgs"]) {
    const args = config[key];
    if (!Array.isArray(args)) continue;
    config[key] = args.filter((arg, i) => {
      const before = args[i - 1];
      if (typeof arg !== "string") return true;
      if (
        permissionFlag.test(arg) ||
        (typeof before === "string" && /^(?:--permission-mode|--ask-for-approval|--sandbox|-[as])$/.test(before))
      )
        return false;
      if (
        (arg === "-c" || arg === "--config") &&
        typeof args[i + 1] === "string" &&
        permissionSetting.test(String(args[i + 1]))
      )
        return false;
      return (
        !permissionSetting.test(arg) &&
        !/^--config=(?:approval_policy|sandbox_mode|sandbox_workspace_write\.network_access)\s*=/.test(arg)
      );
    });
  }
  return config;
}
