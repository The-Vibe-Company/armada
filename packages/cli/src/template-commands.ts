import {
  HARNESSES,
  type LaunchTemplate,
  type OrgSummary,
  parseMachineSize,
  templateRefusalHelp,
  VaultError,
} from "@armada/core";
import { flag, parseArgs, single, values } from "./args.ts";
import { armadaApiUrl } from "./armada-api.ts";
import { control } from "./control.ts";
import { parseTtl } from "./operations.ts";
import type { VaultIo } from "./vault-commands.ts";

const HELP = `Launch templates (readable variables and secret references):
  armada template create NAME --file definition.json [--scope personal|org] [--org NAME|UUID] [--json]
  armada template create NAME --golden UUID --provider boat|modal --agent claude|codex [definition flags]
  armada template list [--org NAME|UUID] [--json]
  armada template get NAME|ID [--revision N] [--org NAME|UUID] [--json]
  armada template publish NAME|ID --expected-revision N --file definition.json [--org NAME|UUID] [--json]
  armada template delete NAME|ID --expected-revision N [--org NAME|UUID] [--json]
  armada template launch NAME|ID --request-key KEY [--revision N] [--prompt TEXT] [--ttl 30m] [--size SIZE] [--repo REPO] [--org NAME|UUID] [--json]

Create/publish accept either a JSON definition file (the definition object, not an API envelope)
or --golden UUID --provider boat|modal --agent claude|codex, optionally --model ID,
--reasoning-effort LEVEL, --connection UUID (repeatable), --variable KEY:UUID:VERSION
(repeatable), --secret KEY:UUID:VERSION (repeatable, references only), --skill PIN (repeatable),
--model-account UUID --model-account-version N. Publish creates a new immutable revision.
With --org, create requires explicit --scope personal|org; otherwise scope defaults to personal
in the organization selected by armada org use. Other actions use the target's existing scope.
Names must be exact and unambiguous; use an ID if names collide across scopes.
Launch uses a required request key: retry the SAME key and body after an unknown outcome.
For name-based launches, the resolved template ID is printed before submission; use that ID
for retries so a later rename or deletion cannot prevent recovery.
Never invent a new key while the original outcome is unknown. Only prompt, TTL, size and
repository can be overridden. No local environment expansion is supported. Secret references deliver environment values to the selected native harness.
Readable values may appear in launch manifests; they are not secrets.
`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFINITION_FLAGS = [
  "--golden",
  "--provider",
  "--agent",
  "--model",
  "--reasoning-effort",
  "--connection",
  "--variable",
  "--secret",
  "--skill",
  "--model-account",
  "--model-account-version",
];
const usage = (message = "Invalid template command. Run armada template --help.") => new VaultError("invalid", message);

export async function templateCommand(argv: readonly string[], io: VaultIo): Promise<number> {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    io.auth.out(HELP);
    return 0;
  }
  const [action, ...rest] = argv;
  if (!["create", "list", "get", "publish", "delete", "launch"].includes(action ?? "")) throw usage();
  const args = parseArgs(rest, [
    "--scope",
    "--revision",
    "--expected-revision",
    "--request-key",
    "--prompt",
    "--size",
    ...DEFINITION_FLAGS,
  ]);
  const defining = action === "create" || action === "publish";
  const allowed = new Set([
    "--org",
    "--json",
    ...(defining ? ["--file", ...DEFINITION_FLAGS] : []),
    ...(action === "create" ? ["--scope"] : []),
    ...(["get", "launch"].includes(action ?? "") ? ["--revision"] : []),
    ...(["publish", "delete"].includes(action ?? "") ? ["--expected-revision"] : []),
    ...(action === "launch" ? ["--request-key", "--prompt", "--ttl", "--size", "--repo"] : []),
  ]);
  for (const key of args.options.keys()) {
    if (!allowed.has(key)) throw usage();
    if (!["--connection", "--variable", "--secret", "--skill"].includes(key)) single(args, key);
  }
  if (args.positionals.length !== (action === "list" ? 0 : 1)) throw usage();
  const orgFlag = single(args, "--org");
  const scope = single(args, "--scope") ?? "personal";
  if (action === "create" && orgFlag !== undefined && !args.options.has("--scope"))
    throw usage("Create with --org requires explicit --scope personal|org.");
  if (scope !== "personal" && scope !== "org") throw usage();
  const body: Record<string, unknown> = {};
  if (action === "create") Object.assign(body, { name: args.positionals[0], scope });
  if (args.options.has("--revision")) body.revision = positive(single(args, "--revision"));
  if (action === "publish" || action === "delete")
    body.expectedRevision = positive(single(args, "--expected-revision"));
  if (defining) {
    const file = single(args, "--file");
    if (file !== undefined) {
      if (DEFINITION_FLAGS.some((key) => args.options.has(key)))
        throw usage("Use either --file or definition flags, not both.");
      try {
        const definition: unknown = JSON.parse(await io.readFile(file));
        if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new Error();
        const allowed = [
          "goldenId",
          "provider",
          "harness",
          "model",
          "reasoningEffort",
          "modelAccount",
          "connections",
          "variables",
          "secrets",
          "skills",
        ];
        if (Object.keys(definition).some((key) => !allowed.includes(key))) throw new Error();
        const d = definition as Record<string, unknown>;
        if (
          d.variables !== undefined &&
          (!Array.isArray(d.variables) ||
            d.variables.some(
              (binding) =>
                !binding ||
                typeof binding !== "object" ||
                Array.isArray(binding) ||
                Object.keys(binding).some((key) => !["key", "variableId", "version"].includes(key)),
            ))
        )
          throw new Error();
        if (
          d.modelAccount !== undefined &&
          (!d.modelAccount ||
            typeof d.modelAccount !== "object" ||
            Array.isArray(d.modelAccount) ||
            Object.keys(d.modelAccount).some((key) => !["id", "version"].includes(key)))
        )
          throw new Error();
        if (
          d.secrets !== undefined &&
          (!Array.isArray(d.secrets) ||
            d.secrets.some(
              (b) =>
                !b ||
                typeof b !== "object" ||
                Array.isArray(b) ||
                Object.keys(b).some((key) => !["key", "secretId", "version"].includes(key)),
            ))
        )
          throw new Error();
        body.definition = definition;
      } catch {
        throw usage(
          "Could not read a supported JSON template definition from --file. Unknown fields and inline secret values are not supported.",
        );
      }
    } else {
      const goldenId = single(args, "--golden"),
        provider = single(args, "--provider"),
        harness = single(args, "--agent");
      if (
        !goldenId ||
        !UUID.test(goldenId) ||
        !["boat", "modal"].includes(provider ?? "") ||
        !(HARNESSES as readonly string[]).includes(harness ?? "")
      )
        throw usage("Definition flags require --golden UUID --provider boat|modal --agent claude|codex.");
      const definition: Record<string, unknown> = { goldenId, provider, harness };
      const model = single(args, "--model"),
        effort = single(args, "--reasoning-effort");
      if (model !== undefined) definition.model = model;
      if (effort !== undefined) definition.reasoningEffort = effort;
      definition.connections = values(args, "--connection");
      definition.skills = values(args, "--skill");
      definition.variables = values(args, "--variable").map((binding) => {
        const [key, variableId, version, extra] = binding.split(":");
        if (!key || !variableId || !UUID.test(variableId) || extra !== undefined)
          throw usage("Use --variable KEY:UUID:VERSION for a readable variable reference.");
        return { key, variableId, version: positive(version) };
      });
      const secrets = values(args, "--secret").map((binding) => {
        const [key, secretId, version, extra] = binding.split(":");
        if (!key || !secretId || !UUID.test(secretId) || extra !== undefined)
          throw usage("Use --secret KEY:UUID:VERSION for a secret reference, never a value.");
        return { key, secretId, version: positive(version) };
      });
      if (secrets.length) definition.secrets = secrets;
      const account = single(args, "--model-account"),
        accountVersion = single(args, "--model-account-version");
      if (account !== undefined || accountVersion !== undefined) {
        if (!account || !UUID.test(account))
          throw usage("A model account requires its UUID and --model-account-version N.");
        definition.modelAccount = { id: account, version: positive(accountVersion) };
      }
      body.definition = definition;
    }
  }
  if (action === "launch") {
    const key = single(args, "--request-key");
    if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      throw usage("Launch requires --request-key (1–128 ASCII letters, digits, dots, underscores, colons or hyphens).");
    body.requestKey = key;
    const prompt = single(args, "--prompt"),
      ttl = single(args, "--ttl"),
      size = single(args, "--size"),
      repo = single(args, "--repo");
    if (prompt !== undefined) body.prompt = prompt;
    if (ttl !== undefined) {
      body.ttlSeconds = parseTtl(ttl);
      if (!Number.isSafeInteger(body.ttlSeconds)) throw usage();
    }
    if (size !== undefined) {
      parseMachineSize(size);
      body.size = size;
    }
    if (repo !== undefined) body.repo = repo;
  }
  const selected = orgFlag ?? (await io.auth.preferences?.read(armadaApiUrl(io.auth.env.ARMADA_URL)));
  if (!selected) throw usage("Select an organization with --org NAME|UUID or armada org use.");
  if (UUID.test(selected)) body.org = selected;
  else {
    const { orgs } = await control<{ orgs: OrgSummary[] }>(io.auth, "org/list", {});
    const matches = orgs.filter((org) => org.name.toLowerCase() === selected.toLowerCase());
    if (matches.length !== 1 || !matches[0]) throw usage("Choose an exact unambiguous organization name or UUID.");
    body.org = matches[0].id;
  }
  if (action !== "create" && action !== "list") {
    const target = args.positionals[0] ?? "";
    if (UUID.test(target)) body.id = target;
    else {
      const { items } = await control<{ items: LaunchTemplate[] }>(io.auth, "templates/list", { org: body.org });
      const matches = items.filter((item) => item.name === target && item.status === "active");
      if (matches.length !== 1 || !matches[0])
        throw usage("Template name not found or ambiguous. Use an exact name or template ID.");
      body.id = matches[0].id;
      if (action === "launch")
        io.auth.err(
          `Resolved template ID: ${body.id}. For recovery, use this ID with the same organization, request key, revision and overrides, even if the template is renamed or deleted.\n`,
        );
    }
  }
  const result = await control<Record<string, unknown>>(
    io.auth,
    `templates/${action}`,
    body,
    action === "launch" ? AbortSignal.timeout(10 * 60_000) : undefined,
  );
  if (flag(args, "--json") || action === "launch") io.auth.out(`${JSON.stringify(result)}\n`);
  else if (action === "get") {
    const revision = result.revision as { revision: number };
    io.auth.out(`${format(result.item as LaunchTemplate)}\nSelected revision: ${revision.revision}\n`);
  } else if (action === "list") {
    const items = result.items as LaunchTemplate[];
    io.auth.out(items.length ? `${items.map(format).join("\n")}\n` : "No templates.\n");
  } else io.auth.out(`${format(result.item as LaunchTemplate)}\n`);
  if (action === "launch" && result.state !== undefined && result.state !== "succeeded") {
    const reason = templateRefusalHelp(result.reason);
    io.auth.err(
      result.state === "failed"
        ? `Template launch refused; no sandbox started. ${reason}\n`
        : `Template launch outcome unknown (not confirmed successful). ${reason} Retry with the same template ID, request key and body.\n`,
    );
    return 1;
  }
  return 0;
}
function positive(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw usage("Revision and version must be positive safe integers.");
  return Number(value);
}
function format(item: LaunchTemplate): string {
  return `${item.id}  ${item.name}  ${item.scope}  ${item.status}  revision ${item.currentRevision}`;
}
