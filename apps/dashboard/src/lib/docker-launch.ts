import type {
  DockerLaunchRequest,
  Harness,
  LaunchCapabilityName,
  LaunchProviderCapabilities,
  LaunchProviderOption,
} from "@armada/core";
import { HARNESSES } from "@armada/core";
import { isUuid } from "./action.ts";
import type { DockerHost } from "./docker-hosts.ts";

/**
 * Launching a sandbox on an owned Docker host (#1380) through the server's contract (#1165, `@armada/core`): the Docker
 * entry of `launch/options`' `providers` (`LaunchProviderOption`), and the normal `sandbox/launch` route with
 * `provider: "docker"` (`DockerLaunchRequest`). A wrong shape disables Docker; an unknown value is ignored.
 */
export const LAUNCH_OPTIONS_ROUTE = "launch/options";

export type DockerCapability = LaunchCapabilityName;
export type DockerLaunchOption = Omit<LaunchProviderOption, "id"> & { id: "docker" };

/** How each capability reads in the dialog; exhaustive, so a capability the server adds must be named here. */
const CAPABILITY_LABELS: Record<DockerCapability, string> = {
  launch: "Launch",
  followupPrompts: "Follow-up messages",
  stop: "Stop",
  delete: "Delete",
  resume: "Resume",
  goldens: "Environments (goldens)",
  repositories: "Repositories",
  github: "GitHub",
  mcp: "MCP tools",
  skills: "Skills",
  exec: "Commands",
  steer: "Steering",
  interrupt: "Interrupt",
  machineSizes: "Machine sizes",
  status: "Status",
  logs: "Conversation",
};

export const DOCKER_CAPABILITIES = Object.keys(CAPABILITY_LABELS) as DockerCapability[];
const SOURCES = ["golden", "image"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The values of a string list this dashboard knows; an unknown one (a newer server's) is ignored, not fatal. */
const knownOf = <T extends string>(value: unknown, known: readonly T[]): T[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value.filter((item): item is T => known.includes(item as T))
    : null;

/**
 * The Docker entry of a `launch/options` answer, or null when the server has none or its shape is wrong. A value this
 * dashboard does not know (a newer source, harness or capability) is ignored, and a capability the answer does not
 * name is unsupported: a newer or older server never takes away what it does say it supports.
 */
export function dockerLaunchOption(payload: unknown): DockerLaunchOption | null {
  if (!isRecord(payload) || !Array.isArray(payload.providers)) return null;
  const entry = payload.providers.find((provider) => isRecord(provider) && provider.id === "docker");
  if (!isRecord(entry)) return null;
  const { enabled, launchSources, harnesses, capabilities, unsupportedReasons } = entry;
  const sources = knownOf(launchSources, SOURCES);
  const agents = knownOf<Harness>(harnesses, HARNESSES);
  if (typeof enabled !== "boolean" || !sources || !agents || !isRecord(capabilities)) return null;
  if (Object.values(capabilities).some((value) => typeof value !== "boolean")) return null;
  const reasons: Partial<Record<DockerCapability, string>> = {};
  if (unsupportedReasons !== undefined) {
    if (!isRecord(unsupportedReasons)) return null;
    for (const name of DOCKER_CAPABILITIES) {
      const reason = unsupportedReasons[name];
      if (typeof reason === "string" && reason.trim()) reasons[name] = reason.trim().slice(0, 200);
    }
  }
  return {
    id: "docker",
    enabled,
    launchSources: sources,
    harnesses: agents,
    capabilities: Object.fromEntries(
      DOCKER_CAPABILITIES.map((name) => [name, capabilities[name] === true]),
    ) as unknown as LaunchProviderCapabilities,
    unsupportedReasons: reasons,
  };
}

/**
 * Whether this host takes a launch now, or why not. The launch needs the server to say it launches on Docker
 * (`capabilities.launch`, from a plain image, with at least one agent) and the host list's `placement`; the host itself must be
 * online. The server checks all of it again.
 */
export function dockerLaunchBlocker(
  option: DockerLaunchOption | null,
  placement: boolean,
  host: Pick<DockerHost, "state">,
): string | null {
  if (host.state === "revoked") return "This host is revoked.";
  if (!option?.enabled) return "This Armada server does not launch on Docker hosts yet.";
  if (!option.capabilities.launch)
    return option.unsupportedReasons.launch ?? "This Armada server does not launch on Docker hosts yet.";
  if (!placement) return "This Armada server does not launch on Docker hosts yet.";
  if (!option.launchSources.includes("image") || option.harnesses.length === 0)
    return "This Armada server does not launch an agent from an image on Docker hosts.";
  if (host.state !== "online") return "The host must be online to launch on it.";
  return null;
}

/**
 * The refusal for a launch whose outcome nobody knows. Only then does the dialog keep its request key, so launching
 * again with the same choices is reconciled by the server; after any other answer the next launch is a new request.
 */
export const UNKNOWN_DOCKER_LAUNCH =
  "The Armada server did not confirm the launch. Launch again without changing anything: the server recognises the same request and does not start a second sandbox.";

/** Where the dialog keeps one host's unconfirmed launch key, across closing and reopening it. */
export function dockerLaunchKeyStorage(hostId: string): string {
  return `armada-docker-launch:${hostId}`;
}

/** What is not available on Docker yet, each with the server's short reason, for the launch dialog to say. */
export function dockerUnavailable(option: DockerLaunchOption): { name: string; reason: string }[] {
  return DOCKER_CAPABILITIES.filter((name) => name !== "launch" && !option.capabilities[name]).map((name) => ({
    name: CAPABILITY_LABELS[name],
    reason: option.unsupportedReasons[name] ?? "Not available on Docker hosts yet.",
  }));
}

/**
 * The agents the dialog offers on Docker (#1507): those the server launches there, in Armada's usual order, Codex
 * first chosen when offered (the first agent Docker hosts ran).
 */
export function dockerHarnesses(option: DockerLaunchOption | null): { offered: Harness[]; initial: Harness | null } {
  const offered = HARNESSES.filter((harness) => option?.harnesses.includes(harness));
  return { offered, initial: offered.includes("codex") ? "codex" : (offered[0] ?? null) };
}

/**
 * The agent the dialog starts on: the server's first choice when the viewer has a usable account for it, else the
 * first offered agent they can launch with, else the first choice (the dialog then says an account is needed).
 */
export function preferredHarness(
  offered: readonly Harness[],
  initial: Harness,
  usable: (harness: Harness) => boolean,
): Harness {
  const first = offered.includes(initial) ? initial : (offered[0] ?? initial);
  if (usable(first)) return first;
  return offered.find(usable) ?? first;
}

export type DockerLaunchArgs = {
  org: string;
  hostId: string;
  image: string;
  harness: Harness;
  credentialId: string;
  requestId: string;
  model: string;
  reasoningEffort: string;
  prompt?: string;
};

/** The `sandbox/launch` body for a Docker host: an agent from a plain image, private, nothing a golden would carry. */
export function dockerLaunchBody(args: DockerLaunchArgs): DockerLaunchRequest {
  if (![args.org, args.hostId, args.credentialId, args.requestId].every(isUuid))
    throw new Error("Docker launch identifiers must be UUIDs.");
  return {
    org: args.org,
    provider: "docker",
    hostId: args.hostId,
    image: args.image,
    harness: args.harness,
    credentialId: args.credentialId,
    requestId: args.requestId,
    model: args.model,
    reasoningEffort: args.reasoningEffort,
    visibility: "private",
    ...(args.prompt ? { prompt: args.prompt } : {}),
  };
}

/** The launched sandbox's id from the normal launch envelope, checked to be a Docker sandbox. */
export function launchedDockerSandbox(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.sandbox)) return null;
  const { id, provider } = payload.sandbox;
  return typeof id === "string" && isUuid(id) && provider === "docker" ? id : null;
}

/** The capabilities that act on an existing sandbox, in the order its page names them. */
const SANDBOX_CAPABILITIES = [
  "logs",
  "followupPrompts",
  "steer",
  "interrupt",
  "stop",
  "delete",
  "resume",
  "exec",
] as const satisfies readonly DockerCapability[];

export type DockerSandboxControls = {
  /** Why each control is unavailable; absent means the server supports it on Docker. */
  reasons: Partial<Record<(typeof SANDBOX_CAPABILITIES)[number], string>>;
  /** What the page lists as unavailable on Docker, with the server's reasons. */
  unavailable: { name: string; reason: string }[];
};

const NO_OPTIONS = "What Docker sandboxes support could not be read from the Armada server.";

/**
 * What a Docker sandbox's page may offer, from the server's Docker capabilities. Without a readable Docker option
 * every control is unavailable: the page shows the reason, never a button the server would refuse.
 */
export function dockerSandboxControls(option: DockerLaunchOption | null): DockerSandboxControls {
  const reasons: DockerSandboxControls["reasons"] = {};
  for (const name of SANDBOX_CAPABILITIES) {
    if (option?.enabled && option.capabilities[name]) continue;
    // A present option says why, even when Docker is disabled there; only an unreadable one is unknown.
    reasons[name] = option ? (option.unsupportedReasons[name] ?? "Not available on Docker hosts yet.") : NO_OPTIONS;
  }
  return {
    reasons,
    unavailable: SANDBOX_CAPABILITIES.flatMap((name) => {
      const reason = reasons[name];
      return reason ? [{ name: CAPABILITY_LABELS[name], reason }] : [];
    }),
  };
}
