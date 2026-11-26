import { AuthError } from "@armada/auth";
import {
  API_FAILURE_HELP,
  DOCKER_HOST_DRAINING_MESSAGE,
  type DockerHostListResponse,
  type DockerHostRegistrationResponse,
  dockerHostResourceDisplay,
  GoldenError,
  type OrgSummary,
  parseDockerMemory,
  isRecord as record,
  validDockerHostResources,
} from "@armada/core";
import { isDockerHostVersionStatus } from "@armada/core/contract";
import { flag, parseArgs, single } from "./args.ts";
import type { AuthIo } from "./auth-commands.ts";
import { type ArmadaCommandClient, createSdkCommandClient } from "./sdk-session.ts";
import { formatTableRows } from "./table.ts";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const VERSION_WARNINGS = {
  outdated: "outdated",
  ahead: "newer than target",
  unknown: "unrecognized version",
  current: null,
};
const HELP = "Usage: armada host add|ls|limits|rm. Run armada host --help for options.\n";
const invalid = (message: string): never => {
  throw new GoldenError("invalid_config", message);
};
const unavailable = (message: string): never => {
  throw new AuthError(message, "unavailable");
};

export async function listHosts(client: ArmadaCommandClient, org: string): Promise<DockerHostListResponse> {
  const value = await client.dockerHost<unknown>("list", { org });
  if (!record(value) || typeof value.placement !== "boolean" || !Array.isArray(value.hosts))
    return unavailable("The server returned an invalid host list.");
  const ids = new Set<string>();
  for (const host of value.hosts) {
    if (
      !record(host) ||
      typeof host.id !== "string" ||
      !UUID.test(host.id) ||
      ids.has(host.id) ||
      !(host.name === null || (typeof host.name === "string" && host.name.trim().length > 0)) ||
      !["pending", "online", "offline", "draining", "revoked"].includes(String(host.state)) ||
      !(
        host.lastSeenAt === null ||
        (typeof host.lastSeenAt === "string" && Number.isFinite(Date.parse(host.lastSeenAt)))
      ) ||
      (host.protocol !== null && (!Number.isSafeInteger(host.protocol) || Number(host.protocol) < 0)) ||
      typeof host.upgradeRequired !== "boolean" ||
      (host.versionStatus !== undefined && !isDockerHostVersionStatus(host.versionStatus)) ||
      !(host.version === undefined || host.version === null || typeof host.version === "string") ||
      (host.running !== undefined && (!Number.isSafeInteger(host.running) || Number(host.running) < 0)) ||
      (host.resources !== undefined && host.resources !== null && !validDockerHostResources(host.resources)) ||
      (host.stoppedSandboxBytes !== undefined &&
        host.stoppedSandboxBytes !== null &&
        (!Number.isSafeInteger(host.stoppedSandboxBytes) || Number(host.stoppedSandboxBytes) < 0)) ||
      (host.diskFreeBytes !== undefined &&
        host.diskFreeBytes !== null &&
        (!Number.isSafeInteger(host.diskFreeBytes) || Number(host.diskFreeBytes) < 0)) ||
      !Number.isSafeInteger(host.sandboxes) ||
      Number(host.sandboxes) < 0
    )
      return unavailable("The server returned an invalid host list.");
    ids.add(host.id);
  }
  return value as unknown as DockerHostListResponse;
}

export async function resolveHostOrganization(client: ArmadaCommandClient, ref: string | undefined): Promise<string> {
  const wanted = ref?.trim().toLowerCase();
  if (wanted && UUID.test(wanted)) return wanted;
  const { orgs } = await client.control<{ orgs: OrgSummary[] }>("org/list", {});
  if (!wanted && orgs.length === 1) return orgs[0]!.id;
  if (!wanted) throw new GoldenError("invalid_config", "Select an organization with --org.");
  const org = orgs.find((item) => item.name.trim().toLowerCase() === wanted);
  if (!org) throw new GoldenError("invalid_config", "You are not a member of that org.");
  return org.id;
}

export async function resolveHost(client: ArmadaCommandClient, org: string, selector: string): Promise<string> {
  if (UUID.test(selector)) return selector.toLowerCase();
  const matches = (await listHosts(client, org)).hosts.filter(
    (host) => host.name === selector && host.state !== "revoked",
  );
  if (matches.length === 0) return invalid(`No non-revoked Docker host named '${selector}'. Run armada host ls.`);
  if (matches.length > 1)
    return invalid(`Docker host name '${selector}' is ambiguous. Use a UUID from armada host ls.`);
  return matches[0]?.id ?? invalid("Docker host resolution failed.");
}

export async function hostCommand(argv: readonly string[], auth: AuthIo): Promise<number> {
  const [operation, ...rest] = argv;
  if (!operation || ["--help", "-h"].includes(operation)) {
    auth.out(HELP);
    return operation ? 0 : 2;
  }
  const options: Record<string, readonly string[]> = {
    add: ["--name"],
    ls: [],
    limits: ["--cpus", "--memory", "--max-sandboxes", "--auto"],
    rm: [],
  };
  if (!Object.hasOwn(options, operation)) return invalid("Unknown host command. Run armada host --help.");
  const args = parseArgs(rest, ["--cpus", "--memory", "--max-sandboxes"], ["--auto"]);
  const allowed = ["--org", "--json", ...options[operation]!];
  const count = args.positionals.length;
  if (
    [...args.options.keys()].some((key) => !allowed.includes(key)) ||
    (operation === "ls" ? count > 1 : count !== (operation === "add" ? 0 : 1))
  )
    return invalid(HELP.trim());
  const orgRef = single(args, "--org");
  const name = single(args, "--name")?.trim();
  if (name !== undefined && (!name || name.length > 64 || /[\p{C}]/u.test(name)))
    return invalid("--name requires 1..64 visible characters.");
  const hostId = args.positionals[0];
  if (operation === "rm" && (!hostId || !UUID.test(hostId))) return invalid("host rm requires a host UUID.");
  const client = await createSdkCommandClient(auth);
  if (operation === "ls") {
    const org = await resolveHostOrganization(client, orgRef);
    const result = await listHosts(client, org);
    if (hostId !== undefined) {
      const matches = result.hosts.filter((host) =>
        UUID.test(hostId) ? host.id === hostId.toLowerCase() : host.name === hostId && host.state !== "revoked",
      );
      if (matches.length !== 1) return invalid("Host not found or name is ambiguous. Use a UUID from armada host ls.");
      result.hosts = matches;
    }
    if (args.options.has("--json")) auth.out(`${JSON.stringify(result, null, 2)}\n`);
    else {
      if (result.targetVersion) auth.out(`Target daemon version: ${result.targetVersion}\n`);
      if (result.minimumVersion) auth.out(`Minimum supported daemon version: ${result.minimumVersion}\n`);
      const table = formatTableRows(
        ["ID", "NAME", "STATE", "LAST SEEN", "VERSION", "RETAINED", "MACHINE", "PER SANDBOX", "RUNNING/CAPACITY"],
        result.hosts.map((host) => {
          const resources = dockerHostResourceDisplay(host);
          const version = host.version?.trim();
          const versionWarning = version && host.versionStatus && VERSION_WARNINGS[host.versionStatus];
          return [
            host.id,
            host.name ?? "—",
            host.state,
            host.lastSeenAt ?? "never",
            `${version || "unknown"}${versionWarning ? ` (${versionWarning})` : ""}`,
            String(host.sandboxes),
            resources.machine,
            resources.limits,
            resources.usage,
          ];
        }),
      );
      auth.out(`${table.header}\n`);
      for (const [index, host] of result.hosts.entries()) {
        auth.out(`${table.rows[index]}\n`);
        if (host.state === "draining") auth.out(`Draining: ${DOCKER_HOST_DRAINING_MESSAGE}\n`);
        if (hostId === undefined)
          auth.out(
            `Docker disk free: ${host.diskFreeBytes == null ? "unknown" : `${(host.diskFreeBytes / 1e9).toFixed(2)} GB`}; stopped sandbox space: ${host.stoppedSandboxBytes == null ? "unknown" : `${(host.stoppedSandboxBytes / 1e9).toFixed(2)} GB`}\n`,
          );
        if (host.state !== "pending" && host.state !== "revoked" && host.upgradeRequired)
          auth.out(`${API_FAILURE_HELP.docker_host_upgrade_required}\n`);
        if (hostId !== undefined)
          auth.out(`Retention: ${host.retentionSeconds == null ? "unknown (upgrade host)" : `${host.retentionSeconds}s`}
Requested retention: ${host.retentionOverrideSeconds == null ? "host default" : `${host.retentionOverrideSeconds}s`}
Docker disk free: ${host.diskFreeBytes == null ? "unknown (upgrade/check host)" : `${(host.diskFreeBytes / 1e9).toFixed(2)} GB (${host.diskFreeBytes} bytes)`}; launch floor: 10 GB
Stopped sandbox space: ${host.stoppedSandboxBytes == null ? "unknown (not reported)" : `${(host.stoppedSandboxBytes / 1e9).toFixed(2)} GB (${host.stoppedSandboxBytes} bytes)`}
Next cleanup: ${host.nextCleanupAt ?? "none reported"} (last check-in: ${host.lastSeenAt ?? "never"})
`);
      }
    }
    return 0;
  }
  if (operation === "limits") {
    const patch: { cpus?: number; memoryBytes?: number; maxSandboxes?: number; auto?: true } = {};
    if (args.options.has("--auto")) {
      if (["--cpus", "--memory", "--max-sandboxes"].some((key) => args.options.has(key)))
        return invalid("--auto resets all limits and cannot be combined with overrides.");
      patch.auto = true;
    } else {
      const cpus = single(args, "--cpus");
      const memory = single(args, "--memory");
      const max = single(args, "--max-sandboxes");
      if (cpus !== undefined) {
        patch.cpus = Number(cpus);
        if (!Number.isFinite(patch.cpus) || patch.cpus < 0.01) return invalid("--cpus must be at least 0.01.");
      }
      if (memory !== undefined) {
        try {
          patch.memoryBytes = parseDockerMemory(memory);
        } catch (error) {
          return invalid(error instanceof Error ? error.message : "Invalid memory.");
        }
      }
      if (max !== undefined) {
        patch.maxSandboxes = Number(max);
        if (!Number.isSafeInteger(patch.maxSandboxes) || patch.maxSandboxes < 1)
          return invalid("--max-sandboxes must be a positive integer.");
      }
      if (!Object.keys(patch).length) return invalid("Provide --cpus, --memory, --max-sandboxes or --auto.");
    }
    const org = await resolveHostOrganization(client, orgRef);
    const resolved = await resolveHost(client, org, hostId!);
    await client.dockerHost("limits", { org, hostId: resolved, ...patch });
    auth.out(
      flag(args, "--json")
        ? `${JSON.stringify({ hostId: resolved, ...patch })}\n`
        : "Host limits updated. Use armada host ls HOST to inspect the policy. Container changes apply on the next start or resume.\n",
    );
    return 0;
  }
  const org = await resolveHostOrganization(client, orgRef);
  if (operation === "rm") {
    const result = await client.dockerHost<{ revoked: boolean }>("revoke", { org, hostId });
    if (result?.revoked !== true) return unavailable("The server did not confirm host revocation.");
    auth.out(
      flag(args, "--json") ? `${JSON.stringify({ hostId, revoked: true })}\n` : `Revoked Docker host ${hostId}.\n`,
    );
    return 0;
  }
  const ticket = await client.dockerHost<DockerHostRegistrationResponse & { command: string; expiresAt: string }>(
    "register-token",
    { org, ...(name === undefined ? {} : { name }) },
  );
  if (
    !ticket ||
    typeof ticket.hostId !== "string" ||
    !UUID.test(ticket.hostId) ||
    typeof ticket.registrationToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(ticket.registrationToken) ||
    typeof ticket.command !== "string" ||
    !ticket.command.trim() ||
    /[\p{Cc}]/u.test(ticket.command) ||
    typeof ticket.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(ticket.expiresAt))
  )
    return unavailable(
      "The server returned an invalid host registration. Do not reissue until its outcome is reconciled.",
    );
  if (flag(args, "--json")) {
    auth.out(`${JSON.stringify(ticket)}\n`);
    return 0;
  }
  auth.out(
    `Run this command on the Docker machine (one-use registration):\n${ticket.command}\nHost: ${ticket.hostId}\nExpires: ${ticket.expiresAt}\n`,
  );
  auth.out(
    `Waiting for the machine to connect… (Ctrl-C to stop waiting; the command stays valid until ${new Date(ticket.expiresAt).toISOString().slice(11, 16)} UTC).\n`,
  );
  const deadline = Math.min(auth.now().getTime() + 300_000, Date.parse(ticket.expiresAt));
  let slept = 0;
  const initialBudget = Math.max(0, deadline - auth.now().getTime());
  try {
    while (auth.now().getTime() < deadline && slept < initialBudget) {
      const host = (await listHosts(client, org)).hosts.find((candidate) => candidate.id === ticket.hostId);
      if (!host) {
        auth.out(
          "The new registration is no longer pending (canceled or expired). If the installer reused an existing machine, it keeps its existing name and registration. Run armada host ls to confirm.\n",
        );
        return 0;
      }
      if (host.state === "online") {
        auth.out(`Docker host ${ticket.hostId} is online.\n`);
        return 0;
      }
      if (host?.state === "revoked") {
        auth.err(`Docker host ${ticket.hostId} was revoked before checking in.\n`);
        return 1;
      }
      const delay = Math.min(2000, deadline - auth.now().getTime(), initialBudget - slept);
      if (delay <= 0) break;
      await (auth.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(delay);
      slept += delay;
    }
  } catch (error) {
    auth.err(
      `Host ${ticket.hostId} check-in is unknown. Run armada host ls; do not issue another registration blindly.\n`,
    );
    throw error;
  }
  auth.err(
    `Host ${ticket.hostId} is still pending or offline; the check-in wait expired. Run armada host ls to reconcile; no registration was reissued.\n`,
  );
  return 1;
}
