import { type LaunchTemplate, type OrgSummary, parseMachineSize, templateRefusalHelp, VaultError } from "@armada/core";
import { flag, parseArgs, single } from "./args.ts";
import { createArmadaApiClient } from "./armada-api.ts";
import type { AuthIo } from "./auth-commands.ts";
import { control } from "./control.ts";
import { parseTtl } from "./operations.ts";
import { resolveArmadaOrigin } from "./sdk-session.ts";

const ACTIONS = ["list", "get", "launch"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const usage = (message = "Invalid template command. Run armada template --help.") => new VaultError("invalid", message);

export async function templateCommand(argv: readonly string[], auth: AuthIo): Promise<number> {
  const [action, ...rest] = argv;
  if (!ACTIONS.includes(action ?? "")) throw usage();
  const args = parseArgs(
    rest,
    ["--revision", "--request-key", "--prompt", "--size", "--model-account", "--model-account-version"],
    ["--keep-after-merge"],
  );
  const allowed = new Set([
    "--org",
    "--json",
    ...(["get", "launch"].includes(action ?? "") ? ["--revision"] : []),
    ...(action === "launch"
      ? [
          "--request-key",
          "--prompt",
          "--ttl",
          "--size",
          "--repo",
          "--model-account",
          "--model-account-version",
          "--keep-after-merge",
        ]
      : []),
  ]);
  for (const key of args.options.keys()) {
    if (!allowed.has(key)) throw usage();
    single(args, key);
  }
  if (args.positionals.length !== (action === "list" ? 0 : 1)) throw usage();
  const orgFlag = single(args, "--org");
  const body: Record<string, unknown> = {};
  if (flag(args, "--keep-after-merge")) body.stopWhenWorkMerged = false;
  if (args.options.has("--revision")) body.revision = positive(single(args, "--revision"));
  if (action === "launch") {
    const key = single(args, "--request-key");
    if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      throw usage("Launch requires --request-key (1–128 ASCII letters, digits, dots, underscores, colons or hyphens).");
    body.requestKey = key;
    const account = single(args, "--model-account"),
      accountVersion = single(args, "--model-account-version");
    if (account !== undefined || accountVersion !== undefined) {
      if (!account || !UUID.test(account))
        throw usage("A model account requires its UUID and --model-account-version N.");
      body.modelAccount = { id: account, version: positive(accountVersion) };
    }
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
  const selected = orgFlag ?? (await auth.preferences?.read(await resolveArmadaOrigin(auth)));
  if (!selected) throw usage("Select an organization with --org NAME|UUID or armada login --org NAME|UUID.");
  if (UUID.test(selected)) body.org = selected;
  else {
    const { orgs } = await control<{ orgs: OrgSummary[] }>(auth, "org/list", {});
    const matches = orgs.filter((org) => org.name.toLowerCase() === selected.toLowerCase());
    if (matches.length !== 1 || !matches[0]) throw usage("Choose an exact unambiguous organization name or UUID.");
    body.org = matches[0].id;
  }
  if (action !== "list") {
    const target = args.positionals[0] ?? "";
    if (UUID.test(target)) body.id = target;
    else {
      const { items } = await control<{ items: LaunchTemplate[] }>(auth, "templates/list", { org: body.org });
      const matches = items.filter((item) => item.name === target && item.status === "active");
      if (matches.length !== 1 || !matches[0])
        throw usage("Template name not found or ambiguous. Use an exact name or template ID.");
      body.id = matches[0].id;
      if (action === "launch")
        auth.err(
          `Resolved template ID: ${body.id}. For recovery, use this ID with the same organization, request key, revision and overrides, even if the template is renamed or deleted.\n`,
        );
    }
  }
  let result: Record<string, unknown>;
  if (action === "launch") {
    const signal = AbortSignal.timeout(10 * 60_000);
    const client = await createArmadaApiClient(auth);
    result = await client.launchFromTemplate(body, signal);
  } else {
    result = await control(auth, `templates/${action}`, body);
  }
  if (flag(args, "--json") || action === "launch") auth.out(`${JSON.stringify(result)}\n`);
  else if (action === "get") {
    const revision = result.revision as { revision: number };
    auth.out(`${format(result.item as LaunchTemplate)}\nSelected revision: ${revision.revision}\n`);
  } else {
    const items = result.items as LaunchTemplate[];
    auth.out(items.length ? `${items.map(format).join("\n")}\n` : "No templates.\n");
  }
  if (action === "launch" && result.state !== undefined && result.state !== "succeeded") {
    const reason = typeof result.message === "string" ? result.message : templateRefusalHelp(result.reason);
    auth.err(
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
