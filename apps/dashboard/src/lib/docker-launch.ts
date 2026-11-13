import { isUuid } from "./action.ts";
import type { DockerHost } from "./docker-hosts.ts";

/**
 * Launching a sandbox on an owned Docker host (#1380), against the contract the #1165 server lane published on #1380
 * (issue comment of 2026-11-13 08:26Z): the Docker entry of `launch/options`' `providers`, and the normal
 * `sandbox/launch` route with `provider: "docker"`. Until the server exports these DTOs from `@armada/core`, this file
 * mirrors only the fields the dashboard reads, and reads them strictly: anything unexpected disables the launch.
 */
export const LAUNCH_OPTIONS_ROUTE = "launch/options";

export const DOCKER_CAPABILITIES = [
  "launch",
  "followupPrompts",
  "stop",
  "delete",
  "resume",
  "goldens",
  "repositories",
  "github",
  "mcp",
  "skills",
  "exec",
  "steer",
  "interrupt",
] as const;

export type DockerCapability = (typeof DOCKER_CAPABILITIES)[number];

export type DockerLaunchOption = {
  enabled: boolean;
  launchSources: string[];
  harnesses: string[];
  capabilities: Record<DockerCapability, boolean>;
  unsupportedReasons: Partial<Record<DockerCapability, string>>;
};

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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** The Docker entry of a `launch/options` answer, or null when the server has none or sends something unexpected. */
export function dockerLaunchOption(payload: unknown): DockerLaunchOption | null {
  if (!isRecord(payload) || !Array.isArray(payload.providers)) return null;
  const entry = payload.providers.find((provider) => isRecord(provider) && provider.id === "docker");
  if (!isRecord(entry)) return null;
  const { enabled, launchSources, harnesses, capabilities, unsupportedReasons } = entry;
  if (typeof enabled !== "boolean" || !strings(launchSources) || !strings(harnesses)) return null;
  if (!isRecord(capabilities) || !DOCKER_CAPABILITIES.every((name) => typeof capabilities[name] === "boolean"))
    return null;
  const reasons: Partial<Record<DockerCapability, string>> = {};
  if (unsupportedReasons !== undefined) {
    if (!isRecord(unsupportedReasons)) return null;
    for (const name of DOCKER_CAPABILITIES) {
      const reason = unsupportedReasons[name];
      if (typeof reason === "string" && reason.trim()) reasons[name] = reason.trim().slice(0, 200);
    }
  }
  return {
    enabled,
    launchSources,
    harnesses,
    capabilities: Object.fromEntries(DOCKER_CAPABILITIES.map((name) => [name, capabilities[name] === true])) as Record<
      DockerCapability,
      boolean
    >,
    unsupportedReasons: reasons,
  };
}

/**
 * Whether this host takes a launch now, or why not. The launch needs the server to say it launches on Docker
 * (`capabilities.launch`, from a plain image, with Codex) and the host list's `placement`; the host itself must be
 * online. The server checks all of it again.
 */
export function dockerLaunchBlocker(
  option: DockerLaunchOption | null,
  placement: boolean,
  host: Pick<DockerHost, "state">,
): string | null {
  if (!option?.enabled) return "This Armada server does not launch on Docker hosts yet.";
  if (!option.capabilities.launch)
    return option.unsupportedReasons.launch ?? "This Armada server does not launch on Docker hosts yet.";
  if (!placement) return "This Armada server does not launch on Docker hosts yet.";
  if (!option.launchSources.includes("image") || !option.harnesses.includes("codex"))
    return "This Armada server does not launch Codex from an image on Docker hosts.";
  if (host.state === "revoked") return "This host is revoked.";
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

/** A digest-pinned image reference: `repository@sha256:<64 hex>`, as the server requires. */
const IMAGE = /^[a-z0-9][a-z0-9._\-/:]{0,254}@sha256:[0-9a-f]{64}$/;

export function checkImage(raw: string): { ok: true; image: string } | { ok: false; error: string } {
  const image = raw.trim();
  if (!IMAGE.test(image))
    return {
      ok: false,
      error: "Enter an image pinned by digest, such as buildpack-deps@sha256:<64 hex characters>.",
    };
  return { ok: true, image };
}

export type DockerLaunchArgs = {
  org: string;
  hostId: string;
  image: string;
  credentialId: string;
  requestId: string;
  model: string;
  reasoningEffort: string;
  prompt?: string;
};

/** The `sandbox/launch` body for a Docker host: Codex from a plain image, private, nothing a golden would carry. */
export function dockerLaunchBody(args: DockerLaunchArgs): Record<string, unknown> {
  if (![args.org, args.hostId, args.credentialId, args.requestId].every(isUuid))
    throw new Error("Docker launch identifiers must be UUIDs.");
  return {
    org: args.org,
    provider: "docker",
    hostId: args.hostId,
    image: args.image,
    harness: "codex",
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
