import type { DockerHostListResponse, DockerHostRegistrationResponse, DockerHostSummary } from "@armada/core";
import { relativeAge } from "./relative-time.ts";
import type { ResourceState } from "./resource-list.ts";

/**
 * The Hosts page (#1380): an organization's owned Docker hosts. Pure logic only; the server calls live in
 * `lib/data/docker-hosts.ts` and `app/actions/docker-hosts.ts`.
 *
 * The routes and their DTOs are the server's (#1165, `@armada/core`). Without `ARMADA_DOCKER_HOSTS=1` the server
 * does not mount them: the list answers 404, which the dashboard reads as "Docker is not enabled here", so the Hosts
 * entry and page stay hidden. Answers are still parsed strictly: the types say what the server promises, not what
 * arrived.
 */
export const DOCKER_HOST_ROUTES = {
  list: "docker/hosts/list",
  registerToken: "docker/hosts/register-token",
  revoke: "docker/hosts/revoke",
} as const;

export const HOSTS_PATH = "/hosts";

/** Where the host keeps its private registration and credential, in the command the dialog shows. */
export const HOST_STATE_DIR = '"$HOME/.local/state/armada-docker-host"';

export type DockerHost = DockerHostSummary;
export type DockerHostState = DockerHost["state"];

/** `skipped`: hosts the server listed that do not match the contract, left out of the list (#1398). */
export type DockerHostList = DockerHostListResponse & { skipped: number };

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
    version: typeof value.version === "string" ? value.version : null,
  };
}

/**
 * The list answer, or null when its envelope is not the expected shape or a host id repeats. A host that does not
 * match the contract is left out and counted in `skipped`, so one unexpected host never hides the others (#1398).
 */
export function parseDockerHostList(value: unknown): DockerHostList | null {
  if (!isRecord(value) || typeof value.placement !== "boolean" || !Array.isArray(value.hosts)) return null;
  const list = value.hosts.map(parseHost).filter((host): host is DockerHost => host !== null);
  if (new Set(list.map((host) => host.id)).size !== list.length) return null;
  return { placement: value.placement, hosts: list, skipped: value.hosts.length - list.length };
}

/** A one-use registration ticket as `register-token` returns it. */
export type HostRegistration = DockerHostRegistrationResponse;

export function parseHostRegistration(value: unknown): HostRegistration | null {
  if (!isRecord(value)) return null;
  const { hostId, registrationToken, command, expiresAt } = value;
  if (typeof hostId !== "string" || !UUID.test(hostId)) return null;
  if (typeof registrationToken !== "string" || !/^[0-9a-f]{64}$/.test(registrationToken)) return null;
  if (typeof command !== "string" || !command || !isDate(expiresAt)) return null;
  return { hostId, registrationToken, command, expiresAt };
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

/** What revoking a host does, said before it happens. */
export function revokeWarning(sandboxes: number): string {
  const base =
    "Its credential stops working and it takes no new work. This cannot be undone: to use the machine again, add it as a new host.";
  if (sandboxes === 0) return base;
  return `${base} It still has ${sandboxCount(sandboxes).toLowerCase()}: delete ${sandboxes === 1 ? "it" : "them"} first, because a revoked host can no longer stop or delete them.`;
}
