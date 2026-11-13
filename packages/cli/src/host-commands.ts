import {
  type DockerHostListResponse,
  type DockerHostRegistrationResponse,
  GoldenError,
  isRecord as record,
} from "@armada/core";
import { parseArgs, single } from "./args.ts";
import { type ArmadaApiClient, createArmadaApiClient } from "./armada-api.ts";
import type { AuthIo } from "./auth-commands.ts";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const HELP =
  "Usage: armada host add [--name NAME] [--org UUID] | list [--json] [--org UUID] | revoke UUID [--org UUID]\n";
const invalid = (message: string): never => {
  throw new GoldenError("invalid_config", message);
};

export async function listHosts(client: ArmadaApiClient, org: string): Promise<DockerHostListResponse> {
  const value = await client.request<unknown>("/api/v1/docker/hosts/list", {
    method: "POST",
    body: JSON.stringify({ org }),
  });
  if (!record(value) || typeof value.placement !== "boolean" || !Array.isArray(value.hosts))
    return invalid("The server returned an invalid host list.");
  const ids = new Set<string>();
  for (const host of value.hosts) {
    if (
      !record(host) ||
      typeof host.id !== "string" ||
      !UUID.test(host.id) ||
      ids.has(host.id) ||
      !(host.name === null || (typeof host.name === "string" && host.name.trim().length > 0)) ||
      !["pending", "online", "offline", "revoked"].includes(String(host.state)) ||
      !(
        host.lastSeenAt === null ||
        (typeof host.lastSeenAt === "string" && Number.isFinite(Date.parse(host.lastSeenAt)))
      ) ||
      !(host.version === undefined || host.version === null || typeof host.version === "string") ||
      !Number.isSafeInteger(host.sandboxes) ||
      Number(host.sandboxes) < 0
    )
      return invalid("The server returned an invalid host list.");
    ids.add(host.id);
  }
  return value as unknown as DockerHostListResponse;
}

export async function resolveHost(client: ArmadaApiClient, org: string, selector: string): Promise<string> {
  if (UUID.test(selector)) return selector.toLowerCase();
  const matches = (await listHosts(client, org)).hosts.filter(
    (host) => host.name === selector && host.state !== "revoked",
  );
  if (matches.length === 0) return invalid(`No non-revoked Docker host named '${selector}'. Run armada host list.`);
  if (matches.length > 1)
    return invalid(`Docker host name '${selector}' is ambiguous. Use a UUID from armada host list.`);
  return matches[0]?.id ?? invalid("Docker host resolution failed.");
}

export async function hostCommand(argv: readonly string[], auth: AuthIo): Promise<number> {
  const [operation, ...rest] = argv;
  if (!operation || ["--help", "-h"].includes(operation)) {
    auth.out(HELP);
    return operation ? 0 : 2;
  }
  const args = parseArgs(rest);
  const allowed =
    operation === "add"
      ? ["--org", "--name"]
      : operation === "list"
        ? ["--org", "--json"]
        : operation === "revoke"
          ? ["--org"]
          : [];
  if (
    !allowed.length ||
    [...args.options.keys()].some((key) => !allowed.includes(key)) ||
    args.positionals.length !== (operation === "revoke" ? 1 : 0)
  )
    return invalid(HELP.trim());
  const org = single(args, "--org");
  if (!org || !UUID.test(org)) return invalid("Select an organization or pass --org UUID.");
  const name = single(args, "--name")?.trim();
  if (name !== undefined && (!name || name.length > 64 || /[\p{C}]/u.test(name)))
    return invalid("--name requires 1..64 visible characters.");
  const hostId = args.positionals[0];
  if (operation === "revoke" && (!hostId || !UUID.test(hostId))) return invalid("host revoke requires a host UUID.");
  const client = await createArmadaApiClient(auth);
  if (operation === "list") {
    const result = await listHosts(client, org);
    if (args.options.has("--json")) auth.out(`${JSON.stringify(result, null, 2)}\n`);
    else {
      auth.out("ID\tNAME\tSTATE\tLAST SEEN\tVERSION\tSANDBOXES\n");
      for (const host of result.hosts)
        auth.out(
          `${host.id}\t${host.name ?? "—"}\t${host.state}\t${host.lastSeenAt ?? "never"}\t${host.version ?? "unknown"}\t${host.sandboxes}\n`,
        );
    }
    return 0;
  }
  if (operation === "revoke") {
    const result = await client.request<{ revoked: boolean }>("/api/v1/docker/hosts/revoke", {
      method: "POST",
      body: JSON.stringify({ org, hostId }),
    });
    if (result?.revoked !== true) return invalid("The server did not confirm host revocation.");
    auth.out(`Revoked Docker host ${hostId}.\n`);
    return 0;
  }
  const ticket = await client.request<DockerHostRegistrationResponse & { command: string; expiresAt: string }>(
    "/api/v1/docker/hosts/register-token",
    { method: "POST", body: JSON.stringify({ org, ...(name === undefined ? {} : { name }) }) },
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
    return invalid("The server returned an invalid host registration. Do not reissue until its outcome is reconciled.");
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
          "The new registration is no longer pending (canceled or expired). If the installer reused an existing machine, it keeps its existing name and registration. Run armada host list to confirm.\n",
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
      `Host ${ticket.hostId} check-in is unknown. Run armada host list; do not issue another registration blindly.\n`,
    );
    throw error;
  }
  auth.err(
    `Host ${ticket.hostId} is still pending or offline; the check-in wait expired. Run armada host list to reconcile; no registration was reissued.\n`,
  );
  return 1;
}
