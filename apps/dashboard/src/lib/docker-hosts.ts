import { relativeAge } from "./relative-time.ts";
import type { ResourceState } from "./resource-list.ts";

/**
 * The Hosts page (#1380): an organization's owned Docker hosts. Pure logic only; the server calls live in
 * `lib/data/docker-hosts.ts` and `app/actions/docker-hosts.ts`.
 *
 * `register-token` and `revoke` are the server's routes on `main` (#1165). `list` is the shape proposed on #1380
 * while the server lane has not published one: until the server mounts it, it answers 404 and the dashboard reads
 * that as "Docker is not enabled here", so the Hosts entry and page stay hidden.
 */
export const DOCKER_HOST_ROUTES = {
  list: "docker/hosts/list",
  registerToken: "docker/hosts/register-token",
  revoke: "docker/hosts/revoke",
} as const;

export const HOSTS_PATH = "/hosts";

/** Where the host keeps its private registration and credential, in the command the dialog shows. */
export const HOST_STATE_DIR = '"$HOME/.local/state/armada-docker-host"';

export type DockerHostState = "pending" | "online" | "offline" | "revoked";

export type DockerHost = {
  id: string;
  name: string | null;
  state: DockerHostState;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  sandboxes: number;
};

export type DockerHostList = { placement: boolean; hosts: DockerHost[] };

const STATES: readonly DockerHostState[] = ["pending", "online", "offline", "revoked"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isDate = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const optionalDate = (value: unknown): value is string | null => value === null || isDate(value);

function parseHost(value: unknown): DockerHost | null {
  if (!isRecord(value)) return null;
  const { id, name, state, createdAt, lastSeenAt, revokedAt, sandboxes } = value;
  if (
    typeof id !== "string" ||
    !UUID.test(id) ||
    !(name === null || (typeof name === "string" && name.trim() !== "")) ||
    !STATES.includes(state as DockerHostState) ||
    !isDate(createdAt) ||
    !optionalDate(lastSeenAt) ||
    !optionalDate(revokedAt) ||
    (state === "revoked") !== (revokedAt !== null) ||
    typeof sandboxes !== "number" ||
    !Number.isInteger(sandboxes) ||
    sandboxes < 0
  )
    return null;
  return {
    id,
    name: name === null ? null : name.trim(),
    state: state as DockerHostState,
    createdAt,
    lastSeenAt,
    revokedAt,
    sandboxes,
  };
}

/** The list answer, or null when it is not the expected shape (one bad row refuses the whole answer). */
export function parseDockerHostList(value: unknown): DockerHostList | null {
  if (!isRecord(value) || typeof value.placement !== "boolean" || !Array.isArray(value.hosts)) return null;
  const hosts = value.hosts.map(parseHost);
  if (hosts.some((host) => host === null)) return null;
  const list = hosts as DockerHost[];
  if (new Set(list.map((host) => host.id)).size !== list.length) return null;
  return { placement: value.placement, hosts: list };
}

/** A one-use registration ticket as `register-token` returns it. */
export type HostRegistration = { hostId: string; registrationToken: string };

export function parseHostRegistration(value: unknown): HostRegistration | null {
  if (!isRecord(value)) return null;
  const { hostId, registrationToken } = value;
  if (typeof hostId !== "string" || !UUID.test(hostId)) return null;
  if (typeof registrationToken !== "string" || !/^[0-9a-f]{64}$/.test(registrationToken)) return null;
  return { hostId, registrationToken };
}

/**
 * A route the server does not mount answers 404 (or 405) without an error code, which `controlPost` reports with no
 * `code`: for the host list, that means Docker hosts are not enabled on this server. Any other refusal is an error.
 */
export function isRouteAbsent(error: { status: number | undefined; code: string | undefined }): boolean {
  return (error.status === 404 || error.status === 405) && error.code === undefined;
}

/** How long a registration token works (the server's `registration_expires_at`). */
export const REGISTRATION_TTL_MS = 5 * 60_000;

/** The first block of a host ID, which is what the page shows until hosts have names. */
export function shortHostId(id: string): string {
  return id.slice(0, 8);
}

export function hostName(host: Pick<DockerHost, "id" | "name">): string {
  return host.name ?? `Host ${shortHostId(host.id)}`;
}

/** A host's state in the page's words and where it sorts: an offline host needs a look first. */
export function hostState(host: DockerHost, now: number): ResourceState & { detail: string } {
  const seen = host.lastSeenAt ? relativeAge(host.lastSeenAt, now) : null;
  switch (host.state) {
    case "online":
      return {
        bucket: "ready",
        tone: "success",
        label: "Online",
        detail: seen ? `Checked in ${seen}.` : "Checked in.",
      };
    case "offline":
      return {
        bucket: "action",
        tone: "warning",
        label: seen ? `Last seen ${seen}` : "Offline",
        detail: "The host has not checked in recently: its daemon may be stopped or the machine offline.",
      };
    case "pending":
      if (now - Date.parse(host.createdAt) > REGISTRATION_TTL_MS)
        return {
          bucket: "action",
          tone: "warning",
          label: "Registration expired",
          detail:
            "Its registration token expired before the host checked in. Revoke this entry and add the host again.",
        };
      return {
        bucket: "action",
        tone: "info",
        label: "Waiting for check-in",
        detail: "Registered here, not yet checked in from the machine.",
      };
    case "revoked":
      return {
        bucket: "rest",
        tone: "neutral",
        label: "Revoked",
        detail: "Revoked: this host can take no new work.",
      };
  }
}

export function sandboxCount(count: number): string {
  if (count === 0) return "No sandboxes";
  return count === 1 ? "1 sandbox" : `${count} sandboxes`;
}

/** Whether the host the dialog registered has checked in from the machine. */
export function hasCheckedIn(list: DockerHostList, hostId: string): boolean {
  const host = list.hosts.find((candidate) => candidate.id === hostId);
  return host !== undefined && host.state !== "pending" && host.state !== "revoked";
}

/**
 * The command run on the machine: it asks for the one-use token without echoing it, so the token never lands in
 * argv, the shell history or the terminal scrollback, passes it on stdin, then runs the daemon in the foreground.
 * Bash or zsh. Null when the server address is not an http(s) origin.
 */
export function hostRegistrationCommand(serverUrl: string): string | null {
  let origin: string;
  try {
    const url = new URL(serverUrl);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    origin = url.origin;
  } catch {
    return null;
  }
  return [
    `(printf 'Registration token: '; read -rs token; echo; printf '%s\\n' "$token" |`,
    `armada-docker-host register --server '${origin}' --state-dir ${HOST_STATE_DIR}) &&`,
    `armada-docker-host run --state-dir ${HOST_STATE_DIR}`,
  ].join(" \\\n  ");
}

/** What revoking a host does, said before it happens. */
export function revokeWarning(sandboxes: number): string {
  const base =
    "Its credential stops working and it takes no new work. This cannot be undone: to use the machine again, add it as a new host.";
  if (sandboxes === 0) return base;
  return `${base} It still has ${sandboxCount(sandboxes).toLowerCase()}: delete ${sandboxes === 1 ? "it" : "them"} first, because a revoked host can no longer stop or delete them.`;
}
