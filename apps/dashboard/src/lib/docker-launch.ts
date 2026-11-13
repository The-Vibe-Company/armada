import type {
  DockerLaunchRequest,
  Harness,
  LaunchCapabilityName,
  LaunchProviderCapabilities,
  LaunchProviderOption,
} from "@armada/core";
import { DOCKER_DEFAULT_IMAGE, HARNESSES } from "@armada/core";
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
 * (`capabilities.launch`, from a plain image, with Codex) and the host list's `placement`; the host itself must be
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
  if (!option.launchSources.includes("image") || !option.harnesses.includes("codex"))
    return "This Armada server does not launch Codex from an image on Docker hosts.";
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

/** An image already used for a sandbox on a host, as the dialog proposes it: the pinned reference and a readable name. */
export type HostImage = { image: string; label: string };

/** How many used images the dialog proposes after the default. */
const RECENT_IMAGES = 5;

/**
 * A readable name for a pinned image: the repository and tag without Docker Hub's `docker.io/` and `library/` prefixes,
 * followed by the digest's first 12 characters, so two versions of one image stay distinguishable.
 */
export function imageLabel(image: string): string {
  const at = image.lastIndexOf("@sha256:");
  const name = (at < 0 ? image : image.slice(0, at)).replace(/^docker\.io\//, "").replace(/^library\//, "");
  return at < 0 ? name : `${name} (${image.slice(at + 8, at + 20)})`;
}

/**
 * The images already used for sandboxes on `hostId`, from sandbox rows sorted newest first: each image once, at its
 * newest use, without Armada's default (always offered first) or a malformed reference, at most RECENT_IMAGES.
 */
export function recentHostImages(
  rows: readonly { docker_host_id: string | null; docker_image: string | null }[],
  hostId: string,
): HostImage[] {
  const seen = new Set([DOCKER_DEFAULT_IMAGE]);
  const images: HostImage[] = [];
  for (const row of rows) {
    const image = row.docker_image;
    if (row.docker_host_id !== hostId || !image || seen.has(image) || !IMAGE.test(image)) continue;
    seen.add(image);
    images.push({ image, label: imageLabel(image) });
    if (images.length === RECENT_IMAGES) break;
  }
  return images;
}

/**
 * The image a launch uses from the dialog's choice: the default, an image already used on the host (its pinned
 * reference is the choice) or a typed custom image. Every non-default image is checked again here.
 */
export function chosenImage(choice: string, custom: string): ReturnType<typeof checkImage> {
  // An empty choice with a typed image is a form from before the choice existed: honour what was typed.
  if (choice === "custom" || (choice === "" && custom.trim())) return checkImage(custom);
  if (choice.includes("@sha256:")) return checkImage(choice);
  if (choice === "default" || choice === "") return { ok: true, image: DOCKER_DEFAULT_IMAGE };
  return { ok: false, error: "Choose an image." };
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
export function dockerLaunchBody(args: DockerLaunchArgs): DockerLaunchRequest {
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
