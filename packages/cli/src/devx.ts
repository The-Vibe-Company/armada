import { AuthError } from "@armada/auth";
import {
  type CredentialInfo,
  type GoldenRecord,
  type LaunchOptionsResponse,
  type OrgCredentials,
  VERSION,
} from "@armada/core";
import { flag, parseArgs, single } from "./args.ts";
import { armadaApiUrl, createArmadaApiClient } from "./armada-api.ts";
import type { AuthIo } from "./auth-commands.ts";
import { control } from "./control.ts";
import { listHosts } from "./host-commands.ts";

const commands =
  "login logout launch list detail status logs send steer stop wait exec golden host account creds org doctor completion template routine";
export function completion(argv: readonly string[], auth: Pick<AuthIo, "out">): number {
  if (argv.length !== 1 || !["bash", "zsh", "fish"].includes(argv[0] ?? ""))
    throw new AuthError("Run armada completion bash|zsh|fish, then source the generated script.", "usage");
  const words = `${commands} --help --version --json --org --provider --agent --credential-id --host --model --ttl`;
  auth.out(
    argv[0] === "bash"
      ? `complete -W '${words}' armada\n`
      : argv[0] === "zsh"
        ? `#compdef armada\n_armada() { compadd -- ${words}; }\ncompdef _armada armada\n`
        : `complete -c armada -f -a '${commands}'\n`,
  );
  return 0;
}

/** Interactive discovery only fills missing choices; ordinary scripted launches retain their exact API contract. */
export async function prepareLaunch(argv: readonly string[], auth: AuthIo): Promise<readonly string[]> {
  if (!auth.interactive || !auth.chooseLaunch || argv.includes("--json") || argv.includes("--")) return argv;
  const args = parseArgs(
    argv,
    [
      "--host",
      "--golden",
      "--size",
      "--skill",
      "--request-id",
      "--credential-version",
      "--variable",
      "--secret",
      "--max-active-children",
    ],
    ["--sized", "--armada-access"],
  );
  // An explicit launch already describes placement and agent: let normal validation handle it unchanged.
  if (
    single(args, "--org") &&
    single(args, "--credential-id") &&
    single(args, "--agent") &&
    (args.positionals.length || single(args, "--host") || single(args, "--golden"))
  )
    return argv;
  const result = [...argv];
  const origin = armadaApiUrl(auth.env.ARMADA_URL);
  const choose = async (key: string, title: string, options: { value: string; label: string }[], fallback?: string) => {
    if (!options.length)
      throw new AuthError(`${title}: no choices available. Run armada doctor to check your setup.`, "usage");
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
        .map((p) => ({ value: p.id, label: p.id === "docker" ? "Your Docker host" : p.id })),
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
  if (provider === "docker") {
    if (!single(args, "--host") && !single(args, "--golden")) {
      const client = await createArmadaApiClient(auth);
      const hosts = await listHosts(client, org);
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
      "Golden (create one with armada golden create)",
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
      "Model account (connect one with armada creds --help)",
      rows.flatMap((c) => (c.id ? [{ value: c.id, label: c.name ?? c.kind }] : [])),
      rows.find((c) => c.isDefault)?.id,
    );
    result.push("--credential-id", account);
  }
  return result;
}

export async function doctor(argv: readonly string[], auth: AuthIo): Promise<number> {
  const args = parseArgs(argv);
  if (args.positionals.length || [...args.options.keys()].some((k) => !["--org", "--json"].includes(k)))
    throw new AuthError("Run armada doctor [--org UUID] [--json].", "usage");
  const rows: { check: string; status: string; detail: string }[] = [];
  const add = (check: string, status: string, detail: string) => rows.push({ check, status, detail });
  const origin = armadaApiUrl(auth.env.ARMADA_URL);
  let org = single(args, "--org") ?? (await auth.preferences?.read(origin));
  try {
    const account = await control<{ version?: string; orgs: { orgId: string; name: string }[] }>(
      auth,
      "account/status",
      {},
    );
    add("Session", "ok", "Signed in");
    add(
      "Server",
      !account.version ? "unknown" : account.version === VERSION ? "ok" : "warning",
      !account.version
        ? "Server version unavailable. Ask the server operator to update Armada."
        : account.version === VERSION
          ? account.version
          : `CLI ${VERSION}; server ${account.version}. Update CLI: npm i -g @the-vibe-company/armada (if CLI is newer, ask the server operator to update).`,
    );
    org ??= account.orgs.length === 1 ? account.orgs[0]?.orgId : undefined;
  } catch {
    add("Session", "failed", "Run armada login; check ARMADA_URL and your network if already signed in.");
    add("Server", "unknown", "Could not read server version. Restore the session/connection and run armada doctor.");
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
    if (connection.status === "connected") {
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
            ? `App installations: ${installations.join(", ")}. Per-repository access is checked at launch. Run armada github status to inspect grants.`
            : connection.installations
              ? "no authorized App installations. Run armada github install, then armada github status."
              : "installation scope unavailable. Run armada github status to inspect grants."
        }`,
      );
    } else if (connection.status === "not_connected") {
      add("GitHub", "warning", "Not connected. Run armada github connect, then armada github status.");
    } else if (connection.status === "needs_reconnect" || connection.status === "revoked") {
      add(
        "GitHub",
        "warning",
        "Connection expired or revoked. Run armada github reconnect, then armada github status.",
      );
    } else {
      add(
        "GitHub",
        "unknown",
        connection.configured === false
          ? "GitHub is not configured on this server. Ask the server operator to configure the GitHub App."
          : "Could not confirm GitHub access. Run armada github status; reconnect only if it reports an expired or revoked connection.",
      );
    }
  } catch {
    add(
      "GitHub",
      "unknown",
      "Could not read GitHub connection. Sign in as a person with armada login (not a service token), then run armada github status; check the server connection if already signed in.",
    );
  }
  if (!org) {
    add("Hosts", "unknown", "Select an organization: armada org list, then armada org use NAME.");
    add("Model accounts", "unknown", "Select an organization, then run armada doctor.");
  } else {
    try {
      const hosts = await listHosts(await createArmadaApiClient(auth), org);
      if (!hosts.hosts.length)
        add("Hosts", "optional", "No Docker hosts. Run armada host add for a host; Modal does not need one.");
      for (const host of hosts.hosts.filter((h) => h.state !== "revoked"))
        add(
          `Host ${host.name ?? host.id}`,
          host.state === "online" ? "ok" : "warning",
          `${host.state}; daemon ${host.version ?? "unknown"}. ${host.state === "online" ? "" : "Check the host machine; run armada host status there."}`,
        );
    } catch {
      add("Hosts", "unknown", "Could not read hosts. Run armada host list.");
    }
    try {
      const accounts = await control<{ user: CredentialInfo[]; orgs: OrgCredentials[] }>(auth, "creds/list", { org });
      const models = [...accounts.user, ...accounts.orgs.flatMap((o) => o.credentials)].filter((c) => c.id);
      if (!models.length)
        add("Model accounts", "failed", "No named model accounts. Run armada creds --help to connect one.");
      for (const model of models)
        add(
          `Account ${model.name ?? model.kind}`,
          model.status ?? "unknown",
          `${model.kind}; metadata only. Run armada creds list to inspect or test the connection.`,
        );
    } catch {
      add("Model accounts", "unknown", "Could not read model accounts. Run armada creds list.");
    }
  }
  auth.out(
    flag(args, "--json")
      ? `${JSON.stringify({ checks: rows }, null, 2)}\n`
      : `CHECK\tSTATUS\tDETAIL / NEXT STEP\n${rows.map((r) => `${r.check}\t${r.status}\t${r.detail.replace(/[\t\r\n]/g, " ")}`).join("\n")}\n`,
  );
  return rows.some((r) => r.status === "failed") ? 1 : 0;
}
