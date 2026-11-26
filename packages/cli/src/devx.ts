import { AuthError } from "@armada/auth";
import {
  type CredentialInfo,
  DOCKER_HOST_DRAINING_MESSAGE,
  type GoldenRecord,
  type LaunchOptionsResponse,
  type OrgCredentials,
  VERSION,
} from "@armada/core";
import { accountOperations, controlRouteKey } from "@armada/core/contract";
import { parseArgs, single, usesHostLaunch } from "./args.ts";
import type { AuthIo } from "./auth-commands.ts";
import { control } from "./control.ts";
import { listHosts, resolveHostOrganization } from "./host-commands.ts";
import { createSdkCommandClient, resolveArmadaOrigin } from "./sdk-session.ts";
import { formatTable } from "./table.ts";
export async function prepareLaunch(argv: readonly string[], auth: AuthIo): Promise<readonly string[]> {
  if (!auth.interactive || !auth.chooseLaunch || argv.includes("--json") || argv.includes("--")) return argv;
  const args = parseArgs(
    argv,
    [
      "--host",
      "--golden",
      "--skill",
      "--idempotency-key",
      "--credential-version",
      "--variable",
      "--secret",
      "--max-active-children",
    ],
    ["--armada-access", "--keep-after-merge"],
  );
  if (single(args, "--provider") && (args.positionals.length || single(args, "--host") || single(args, "--golden")))
    return argv;
  const result = [...argv];
  const origin = await resolveArmadaOrigin(auth);
  const choose = async (key: string, title: string, options: { value: string; label: string }[], fallback?: string) => {
    if (!options.length)
      throw new AuthError(`${title}: no choices available. Run armada info --setup to check your setup.`, "usage");
    const remembered = await auth.launchPreferences?.read(`${origin}/${key}`);
    const preferred = options.find((o) => o.value === remembered)?.value ?? fallback ?? options[0]?.value;
    const value = options.length === 1 ? options[0]?.value : await auth.chooseLaunch?.(title, options, preferred);
    if (!value || !options.some((o) => o.value === value))
      throw new AuthError(`Choose one of the listed ${title.toLowerCase()} options.`, "usage");
    await auth.launchPreferences?.write(`${origin}/${key}`, value);
    return value;
  };
  let org = single(args, "--org");
  if (!org) {
    const { orgs } = await control<{ orgs: { id: string; name: string }[] }>(auth, "org/list", {});
    org = await choose(
      "org",
      "Organization",
      orgs.map((o) => ({ value: o.id, label: o.name })),
    );
    result.push("--org", org);
  }
  const options = await control<LaunchOptionsResponse>(auth, "launch/options", { org });
  let provider = single(args, "--provider");
  if (!provider) {
    provider = await choose(
      `${org}/provider`,
      "Provider",
      options.providers
        .filter((p) => p.enabled && p.capabilities.launch)
        .map((p) => ({ value: p.id, label: usesHostLaunch(p.id) ? "Your Docker host" : p.id })),
    );
    result.push("--provider", provider);
  }
  const available = options.providers.find((p) => p.id === provider);
  let agent = single(args, "--agent");
  if (!agent) {
    agent = await choose(
      `${org}/${provider}/agent`,
      "Agent",
      (available?.harnesses ?? []).map((id) => ({ value: id, label: id })),
      available?.harnesses.includes("codex") ? "codex" : undefined,
    );
    result.push("--agent", agent);
  }
  if (usesHostLaunch(provider)) {
    if (!single(args, "--host") && !single(args, "--golden")) {
      const client = await createSdkCommandClient(auth);
      const hosts = await listHosts(client, await resolveHostOrganization(client, org));
      const host = await choose(
        `${org}/host`,
        "Host (add one with armada host add)",
        hosts.hosts.filter((h) => h.state === "online").map((h) => ({ value: h.id, label: h.name ?? h.id })),
      );
      result.push("--host", host);
    }
  } else if (!args.positionals.length) {
    const { goldens } = await control<{ goldens: GoldenRecord[] }>(auth, "golden/list", { org });
    const golden = await choose(
      `${org}/${provider}/golden`,
      "Snapshot (create one with armada snapshot new)",
      goldens.filter((g) => g.provider === provider).map((g) => ({ value: g.name, label: g.name })),
    );
    result.unshift(golden);
  }
  if (!single(args, "--credential-id")) {
    const accounts = await control<{ user: CredentialInfo[]; orgs: OrgCredentials[] }>(auth, "creds/list", { org });
    const kinds = options.harnesses.find((h) => h.id === agent)?.credentialKinds ?? [];
    const rows = [...accounts.user, ...accounts.orgs.flatMap((o) => o.credentials)].filter(
      (c) => c.id && kinds.includes(c.kind) && c.status !== "revoked" && c.status !== "expired",
    );
    const account = await choose(
      `${org}/${agent}/account`,
      "Model account (connect one with armada account --help)",
      rows.flatMap((c) => (c.id ? [{ value: c.id, label: c.name ?? c.kind }] : [])),
      rows.find((c) => c.isDefault)?.id,
    );
    result.push("--credential-id", account);
  }
  return result;
}

export async function setupStatus(org: string | undefined, json: boolean, auth: AuthIo): Promise<number> {
  const rows: { check: string; status: string; detail: string }[] = [];
  const add = (check: string, status: string, detail: string) => rows.push({ check, status, detail });
  const origin = await resolveArmadaOrigin(auth);
  let visibleOrgs: readonly { orgId: string }[] | undefined;
  try {
    const operation = accountOperations.readAccountStatus;
    const account = operation.output.parse(await control(auth, controlRouteKey(operation.route), {}));
    visibleOrgs = account.orgs;
    org ??= visibleOrgs.length === 1 ? visibleOrgs[0]?.orgId : undefined;
    add("Session", "ok", `Signed in as ${account.userId} (${account.authentication})`);
    const [serverStatus, serverDetail] = serverVersionCheck(origin, account.version);
    add("Server", serverStatus, serverDetail);
  } catch {
    add(
      "Session",
      "failed",
      auth.env.ARMADA_TOKEN
        ? "Check or replace ARMADA_TOKEN; check ARMADA_URL and your network."
        : "Run armada login; check ARMADA_URL and your network if already signed in.",
    );
    add(
      "Server",
      "unknown",
      "Could not read server version. Restore the session/connection and run armada info --setup.",
    );
  }
  try {
    const { connection } = await control<{
      connection: {
        status: string;
        login: string | null;
        configured?: boolean;
        installations?: { account: string; repository_selection?: string }[];
      };
    }>(auth, "github/status", {});
    if (connection.configured === false) {
      add(
        "GitHub",
        "unknown",
        "GitHub is not configured on this server. Ask the server operator to configure the GitHub App.",
      );
    } else if (connection.status === "connected") {
      const installations = (connection.installations ?? []).map(
        (installation) =>
          `${installation.account} (${
            installation.repository_selection === "all"
              ? "all repositories"
              : installation.repository_selection === "selected"
                ? "selected repositories"
                : "repository selection unavailable"
          })`,
      );
      add(
        "GitHub",
        installations.length ? "ok" : "warning",
        `Connected as ${connection.login ?? "unknown user"}; ${
          installations.length
            ? `App installations: ${installations.join(", ")}. Per-repository access is checked at launch. Run armada account ls github to inspect grants.`
            : connection.installations
              ? "no authorized App installations. Run armada account add github, then armada account ls github."
              : "installation scope unavailable. Run armada account ls github to inspect grants."
        }`,
      );
    } else if (connection.status === "not_connected") {
      add("GitHub", "warning", "Not connected. Run armada account login github, then armada account ls github.");
    } else if (connection.status === "needs_reconnect" || connection.status === "revoked") {
      add(
        "GitHub",
        "warning",
        "Connection expired or revoked. Run armada account login github, then armada account ls github.",
      );
    } else {
      add(
        "GitHub",
        "unknown",
        "Could not confirm GitHub access. Run armada account ls github; reconnect only if it reports an expired or revoked connection.",
      );
    }
  } catch {
    add(
      "GitHub",
      "unknown",
      auth.env.ARMADA_TOKEN
        ? "Could not read GitHub connection. For a service token, unset ARMADA_TOKEN and run armada login as a person, then armada account ls github; otherwise check the token and server connection."
        : "Could not read GitHub connection. Run armada account ls github; check the server connection and sign in with armada login if the session expired.",
    );
  }
  if (!org) add("Organization", "unknown", "No organization selected. Use --org UUID.");
  else if (!visibleOrgs) add("Organization", "unknown", org);
  else if (visibleOrgs.some(({ orgId }) => orgId.toLowerCase() === org?.toLowerCase())) add("Organization", "ok", org);
  else add("Organization", "warning", `${org} is outside your visible memberships. Check armada org list.`);
  if (!org) {
    add("Hosts", "unknown", "Select an organization with --org UUID. Find IDs with armada org list.");
  } else {
    try {
      const hosts = await listHosts(await createSdkCommandClient(auth), org);
      if (!hosts.hosts.length)
        add("Hosts", "optional", "No Docker hosts. Run armada host add for a host; Modal does not need one.");
      for (const host of hosts.hosts.filter((h) => h.state !== "revoked"))
        add(
          `Host ${host.name ?? host.id}`,
          host.state !== "online" ? "warning" : !host.version ? "unknown" : host.version === VERSION ? "ok" : "warning",
          `${host.state}; daemon ${host.version ?? "unknown"}. ${
            host.state === "draining"
              ? DOCKER_HOST_DRAINING_MESSAGE
              : host.state !== "online"
                ? "On the host machine, check the status of the daemon instance for this server."
                : host.version === VERSION
                  ? ""
                  : `CLI ${VERSION}. On the host machine, check the status of the daemon instance for this server.`
          }`,
        );
    } catch {
      add("Hosts", "unknown", "Could not read hosts. Run armada host ls.");
    }
  }
  try {
    const accounts = await control<{ user: CredentialInfo[]; orgs: OrgCredentials[] }>(auth, "creds/list", { org });
    const models = [...accounts.user, ...accounts.orgs.flatMap((o) => o.credentials)].filter((c) => c.id);
    if (!models.length)
      add("Model accounts", "failed", "No named model accounts. Run armada account --help to connect one.");
    for (const model of models)
      add(
        `Account ${model.name ?? model.kind}`,
        model.status ?? "unknown",
        `${model.kind}; metadata only. Run armada account ls to inspect or test the connection.`,
      );
  } catch {
    add("Model accounts", "unknown", "Could not read model accounts. Run armada account ls.");
  }
  auth.out(
    json
      ? `${JSON.stringify({ checks: rows }, null, 2)}\n`
      : formatTable(
          ["CHECK", "STATUS", "DETAIL / NEXT STEP"],
          rows.map((r) => [r.check, r.status, r.detail.replace(/[\t\r\n]/g, " ")]),
        ),
  );
  return rows.some((r) => r.status === "failed") ? 1 : 0;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function compareSemver(a: string, b: string) {
  const l = SEMVER.exec(a.trim()),
    r = SEMVER.exec(b.trim());
  if (!l || !r) return null;
  for (const i of [1, 2, 3] as const) {
    const diff = Number(l[i]) - Number(r[i]);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (!l[4] && !r[4]) return 0;
  if (!l[4] || !r[4]) return l[4] ? -1 : 1;
  const lp = l[4].split("."),
    rp = r[4].split(".");
  for (let i = 0; i < Math.max(lp.length, rp.length); i++) {
    const aPart = lp[i],
      bPart = rp[i];
    if (aPart === bPart) continue;
    if (aPart === undefined || bPart === undefined) return aPart === undefined ? -1 : 1;
    const aNum = /^\d+$/.test(aPart),
      bNum = /^\d+$/.test(bPart);
    if (aNum && bNum) return Number(aPart) > Number(bPart) ? 1 : -1;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return aPart > bPart ? 1 : -1;
  }
  return 0;
}

function serverVersionCheck(origin: string, serverVersion: string | undefined) {
  const trimmed = serverVersion?.trim();
  if (!trimmed) return ["unknown", "Server version unavailable. Ask the server operator to update Armada."] as const;
  const compared = trimmed === VERSION ? 0 : compareSemver(VERSION, trimmed);
  if (compared === 0) return ["ok", `${origin} · ${trimmed}`] as const;
  if (compared !== null && compared > 0)
    return [
      "info",
      `${origin} · CLI ${VERSION} is ahead of server ${trimmed}. Ask the server operator to update Armada.`,
    ] as const;
  if (compared !== null && compared < 0)
    return [
      "warning",
      `${origin} · CLI ${VERSION}; server ${trimmed}. Update CLI: npm i -g @the-vibe-company/armada@${trimmed}`,
    ] as const;
  return ["warning", `${origin} · CLI ${VERSION}; server ${trimmed}.`] as const;
}
