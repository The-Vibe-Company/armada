import {
  type DockerHostListResponse,
  type DockerHostSummary,
  dockerHostResourceDisplay,
  validDockerHostResources,
} from "@armada/core";
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

/** A parsed host: the daemon version is narrowed to a non-empty string or null (unknown). */
export type DockerHost = Omit<DockerHostSummary, "version"> & { version: string | null };
export type DockerHostState = DockerHost["state"];

/** `skipped`: hosts the server listed that do not match the contract, left out of the list (#1398). */
export type DockerHostList = Omit<DockerHostListResponse, "hosts"> & { hosts: DockerHost[]; skipped: number };

const STATES: readonly DockerHostState[] = ["pending", "online", "offline", "revoked"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isDate = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const optionalDate = (value: unknown): value is string | null => value === null || isDate(value);

function parseHost(value: unknown): DockerHost | null {
  if (!isRecord(value)) return null;
  const { id, name, state, createdAt, lastSeenAt, revokedAt, sandboxes, version } = value;
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
    sandboxes < 0 ||
    (value.running !== undefined && (!Number.isSafeInteger(value.running) || Number(value.running) < 0)) ||
    (value.resources !== undefined && value.resources !== null && !validDockerHostResources(value.resources))
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
    ...(value.running === undefined ? {} : { running: value.running as number }),
    ...(value.resources === undefined
      ? {}
      : { resources: value.resources as Exclude<DockerHost["resources"], undefined> }),
    version: typeof version === "string" && version.trim() !== "" ? version.trim() : null,
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

/**
 * What `register-token` answers (#1453, #1471): the single shell line to paste on the machine, with its one-use
 * token inside, and when it stops working. The command is shown once and kept nowhere: not in storage, a URL or a
 * log. Any token field the server also sends is dropped here, so the dialog never holds it on its own.
 */
export type HostRegistration = { hostId: string; command: string; expiresAt: string };

/** Longest command accepted: one line, far longer than the installer's. */
const COMMAND_MAX = 2048;

export function parseHostRegistration(value: unknown): HostRegistration | null {
  if (!isRecord(value)) return null;
  const { hostId, command, expiresAt } = value;
  if (typeof hostId !== "string" || !UUID.test(hostId)) return null;
  if (typeof command !== "string" || command.trim() === "" || command.length > COMMAND_MAX) return null;
  // One line: what is copied is exactly what is shown and runs as a single command.
  if (/[\r\n]/.test(command)) return null;
  if (!isDate(expiresAt)) return null;
  return { hostId, command: command.trim(), expiresAt };
}

/** Longest optional host name the dialog sends. */
export const HOST_NAME_MAX = 64;

/** The optional name from the dialog: trimmed, null when blank, an error when too long. */
export function hostNameInput(raw: string): { ok: true; name: string | null } | { ok: false; error: string } {
  const name = raw.trim();
  if (name === "") return { ok: true, name: null };
  if (name.length > HOST_NAME_MAX) return { ok: false, error: `A host name is at most ${HOST_NAME_MAX} characters.` };
  return { ok: true, name };
}

/** Time left before the command expires as `m:ss`, or null once it has. */
export function expiryCountdown(expiresAt: string, now: number): string | null {
  const left = Math.ceil((Date.parse(expiresAt) - now) / 1000);
  if (!(left > 0)) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
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

/** The name of the host the dialog registered once it has connected from the machine, else null. */
export function connectedHostName(list: DockerHostList, hostId: string): string | null {
  const host = list.hosts.find((candidate) => candidate.id === hostId);
  if (!host || host.state === "pending" || host.state === "revoked") return null;
  return hostName(host);
}

/** A row's fact: what runs there and which daemon runs it. */
export function hostFact(host: Pick<DockerHost, "sandboxes" | "version" | "resources" | "running">): string {
  return `${dockerHostResourceDisplay(host).usage} running/capacity · ${sandboxCount(host.sandboxes)} retained · ${host.version ? `v${host.version.replace(/^v/, "")}` : "version unknown"}`;
}

/** What revoking a host does, said before it happens. */
export function revokeWarning(sandboxes: number): string {
  const base =
    "Its credential stops working and it takes no new work. This cannot be undone: to use the machine again, add it as a new host.";
  if (sandboxes === 0) return base;
  return `${base} It still has ${sandboxCount(sandboxes).toLowerCase()}: delete ${sandboxes === 1 ? "it" : "them"} first, because a revoked host can no longer stop or delete them.`;
}

/** A Docker sandbox's host in its page's details: the host's name when the list has it, else its short id (#1526). */
export function sandboxHostLabel(list: DockerHostList | null, hostId: string | null): string {
  if (!hostId) return "Unknown";
  const host = list?.hosts.find((candidate) => candidate.id === hostId);
  return host ? hostName(host) : `Host ${shortHostId(hostId)}`;
}
