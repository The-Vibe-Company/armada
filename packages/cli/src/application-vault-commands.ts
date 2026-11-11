import { type OrgSummary, VaultError } from "@armada/core";
import { flag, parseArgs, single } from "./args.ts";
import { armadaApiUrl } from "./armada-api.ts";
import { control } from "./control.ts";
import type { VaultIo } from "./vault-commands.ts";

const HELP = `Application variables and write-only secrets (not model credentials):
  armada vars set <NAME> [--file <path>] [--scope personal|org] [--org <name|UUID>] [--json]
  armada vars list [--org <name|UUID>] [--json]
  armada vars read <id> [--org <name|UUID>] [--json]
  armada secrets set <NAME> [--file <path>] [--scope personal|org] [--org <name|UUID>] [--json]
  armada secrets list [--org <name|UUID>] [--json]
  armada secrets rotate <id> --expected-version <N> [--file <path>] [--org <name|UUID>] [--json]
  armada secrets revoke|delete <id> --expected-version <N> [--org <name|UUID>] [--json]

Values come only from piped stdin or --file; bytes are preserved, never echoed or cached.
Set creates a new entry; duplicate names conflict. With --org, set requires explicit
--scope personal|org. Without --org, set defaults to personal in the organization
selected by armada org use.
Lists include your personal entries and visible organization entries; IDs determine mutation scope.
Only vars read prints the readable value (without adding a newline); vars read --json includes the value
alongside item metadata. Lists, writes and all secret output remain metadata only.
Secrets have no read/reveal/export operation.
Org members can read; only admins can mutate org entries. Revoke is terminal; delete
before reusing a revoked name. No sandbox delivery or upstream rotation is performed.
`;

/** Application vault management stays separate from model-account credentials. */
export async function applicationVaultCommand(
  resource: "vars" | "secrets",
  argv: readonly string[],
  io: VaultIo,
): Promise<number> {
  if (argv.length === 0 || argv.includes("--help")) {
    io.auth.out(HELP);
    return 0;
  }
  const input = parseInput(resource, argv);
  const body: Record<string, unknown> = {};
  if (input.action === "set") {
    body.scope = input.scope;
    body.name = input.target;
  } else if (input.action !== "list") body.id = input.target;
  if (input.version !== undefined) body.expectedVersion = input.version;
  // Read before any API request. Input failures must never expose file paths or contents.
  if (input.action === "set" || input.action === "rotate") {
    try {
      body.value = await (input.file === undefined ? io.readStdin() : io.readFile(input.file));
    } catch {
      throw new VaultError("invalid", "Could not read value. Pipe it on stdin or use --file <path>.");
    }
  }
  const selected = input.org ?? (await io.auth.preferences?.read(armadaApiUrl(io.auth.env.ARMADA_URL)));
  if (!selected) throw new VaultError("invalid", "Select an organization with --org <name|UUID> or armada org use.");
  body.org = await resolveOrganization(selected, io);
  const routes = {
    set: resource === "vars" ? "variables/set" : "secrets/set",
    list: resource === "vars" ? "variables/list" : "secrets/list",
    read: "variables/read",
    rotate: "secrets/rotate",
    revoke: "secrets/revoke",
    delete: "secrets/delete",
  } as const;
  const result = await control<{ item?: Record<string, unknown>; items?: Record<string, unknown>[]; value?: string }>(
    io.auth,
    routes[input.action],
    body,
  );
  if (input.action === "list") {
    const items = (result.items ?? []).map(metadata);
    io.auth.out(
      input.json
        ? `${JSON.stringify({ items })}\n`
        : items.length
          ? `${items.map(format).join("\n")}\n`
          : "No entries.\n",
    );
  } else if (input.action === "read") {
    if (typeof result.value !== "string") throw new VaultError("unavailable", "Variable value unavailable.");
    io.auth.out(
      input.json ? `${JSON.stringify({ item: metadata(result.item ?? {}), value: result.value })}\n` : result.value,
    );
  } else {
    const item = metadata(result.item ?? {});
    io.auth.out(input.json ? `${JSON.stringify({ item })}\n` : `${format(item)}\n`);
  }
  return 0;
}

function parseInput(resource: "vars" | "secrets", argv: readonly string[]) {
  try {
    const [action, ...rest] = argv;
    if (
      !(resource === "vars" ? ["set", "list", "read"] : ["set", "list", "rotate", "revoke", "delete"]).includes(
        action ?? "",
      )
    )
      throw new Error();
    const args = parseArgs(rest, ["--scope"]);
    const writing = action === "set" || action === "rotate";
    const versioned = action === "rotate" || action === "revoke" || action === "delete";
    const allowed = new Set([
      "--org",
      "--json",
      ...(writing ? ["--file"] : []),
      ...(action === "set" ? ["--scope"] : []),
      ...(versioned ? ["--expected-version"] : []),
    ]);
    for (const key of args.options.keys()) if (!allowed.has(key)) throw new Error();
    if (args.positionals.length !== (action === "list" ? 0 : 1)) throw new Error();
    const org = single(args, "--org");
    const explicitScope = single(args, "--scope");
    if (action === "set" && org !== undefined && explicitScope === undefined)
      throw new VaultError("invalid", "Set with --org requires explicit --scope personal|org.");
    const scope = explicitScope ?? "personal";
    if (scope !== "personal" && scope !== "org") throw new Error();
    const revision = single(args, "--expected-version");
    if (versioned && (!revision || !/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision))))
      throw new Error();
    return {
      action: action as "set" | "list" | "read" | "rotate" | "revoke" | "delete",
      target: args.positionals[0],
      org,
      scope,
      file: single(args, "--file"),
      version: revision === undefined ? undefined : Number(revision),
      json: flag(args, "--json"),
    };
  } catch (error) {
    if (error instanceof VaultError) throw error;
    // Rejected arguments may themselves contain a value. Do not interpolate them.
    throw new VaultError(
      "invalid",
      "Invalid application vault command. Run armada vars --help or armada secrets --help. Values are accepted only on stdin or from --file, never as arguments.",
    );
  }
}

async function resolveOrganization(ref: string, io: VaultIo): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref;
  const { orgs } = await control<{ orgs: OrgSummary[] }>(io.auth, "org/list", {});
  const matches = orgs.filter((org) => org.name.toLowerCase() === ref.toLowerCase());
  if (matches.length !== 1 || !matches[0])
    throw new VaultError("invalid", "Choose one of your organizations by UUID or exact unambiguous name.");
  return matches[0].id;
}

/** Project only safe scalar metadata, never a future value/ciphertext field. */
function metadata(row: Record<string, unknown>): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (const key of [
    "id",
    "orgId",
    "ownerId",
    "scope",
    "name",
    "version",
    "epoch",
    "status",
    "expiresAt",
    "createdAt",
    "updatedAt",
  ]) {
    const value = row[key];
    if (value === null || typeof value === "string" || typeof value === "number") item[key] = value;
  }
  return item;
}

function format(item: Record<string, unknown>): string {
  return `${item.id}  ${item.name}  ${item.scope}  ${item.status}  version ${item.version}`;
}
