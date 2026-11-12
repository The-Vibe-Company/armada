import { type OrgSummary, type Routine, routineReasonHelp, VaultError } from "@armada/core";
import { flag, parseArgs, single } from "./args.ts";
import { armadaApiUrl } from "./armada-api.ts";
import { control } from "./control.ts";
import { parseTtl } from "./operations.ts";
import type { VaultIo } from "./vault-commands.ts";

const HELP = `Scheduled template launches (run as the routine owner):
  armada routine create NAME --file config.json [--scope personal|org] [--org NAME|UUID] [--json]
  armada routine create NAME --template UUID --revision N (--prompt TEXT | --prompt-file PATH) --cron EXPRESSION --timezone IANA_ZONE [--ttl 1h] [--max-runs-per-day N] [--scope personal|org] [--org NAME|UUID] [--json]
  armada routine list [--org NAME|UUID] [--json]
  armada routine show NAME|ID [--org NAME|UUID] [--json]
  armada routine update NAME|ID --expected-version N (--file config.json | --cron EXPRESSION --timezone IANA_ZONE) [--org NAME|UUID] [--json]
  armada routine enable NAME|ID --expected-version N [--org NAME|UUID] [--json]
  armada routine pause NAME|ID --expected-version N [--org NAME|UUID] [--json]
  armada routine delete NAME|ID --expected-version N [--org NAME|UUID] [--json]
  armada routine runs NAME|ID [--org NAME|UUID] [--json]

Create JSON requires templateId, templateRevision, prompt, cron and timezone.
Optional ttlSeconds and maxRunsPerDay default to 3600 seconds and 24 launches/day.
Update JSON replaces ALL mutable configuration and requires every field above plus
name. Inline update changes only the schedule, retaining current mutable fields;
--expected-version still guards that complete replacement. Create takes name from
NAME. Neither file accepts org, owner, scope or intervalHours.
With --org, create requires explicit --scope personal|org; otherwise scope defaults
to personal in the organization selected by armada org use. Names must be exact
and unambiguous. Use the ID for history of deleted routines.
--prompt-file reads UTF-8 bytes without trimming; use - for piped stdin. Prompts are
readable configuration, not a place for secrets. Quote the standard five-field cron
expression and choose an IANA time zone (for example Europe/Paris or UTC).
Runs must remain at least ONE HOUR apart, including DST transitions.
TTL is 5 minutes–24 hours; daily cap is 1–24 admitted launches.
New routines are paused. Enable schedules the next occurrence, not an immediate manual launch.
Updating an enabled routine selects the next matching cron occurrence. Copy version from show/list;
conflicts are not retried. Pause/delete stop new admissions, not already admitted runs.
Runs shows the latest 100 decisions, including readable skip/failure reasons and
original-prompt outcomes. Launch success is not task success; unknown is not success.
`;
const ROUTES = {
  create: "create",
  list: "list",
  show: "get",
  update: "update",
  enable: "enable",
  pause: "pause",
  delete: "delete",
  runs: "history",
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIG = ["name", "templateId", "templateRevision", "prompt", "cron", "timezone", "ttlSeconds", "maxRunsPerDay"];
const INLINE = [
  "--template",
  "--revision",
  "--prompt",
  "--prompt-file",
  "--cron",
  "--timezone",
  "--max-runs-per-day",
  "--ttl",
];
const invalid = (message = "Invalid routine command. Run armada routine --help.") => new VaultError("invalid", message);

export async function routineCommand(argv: readonly string[], io: VaultIo): Promise<number> {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    io.auth.out(HELP);
    return 0;
  }
  const [action, ...rest] = argv;
  if (!action || !Object.hasOwn(ROUTES, action)) throw invalid();
  const args = parseArgs(rest, ["--scope", ...INLINE]);
  const versioned = ["update", "enable", "pause", "delete"].includes(action ?? "");
  const allowed = new Set([
    "--org",
    "--json",
    ...(versioned ? ["--expected-version"] : []),
    ...(action === "create" ? ["--scope", "--file", ...INLINE] : []),
    ...(action === "update" ? ["--file", "--cron", "--timezone"] : []),
  ]);
  for (const key of args.options.keys()) {
    if (!allowed.has(key)) throw invalid();
    single(args, key);
  }
  if (args.positionals.length !== (action === "list" ? 0 : 1)) throw invalid();
  const body: Record<string, unknown> = {};
  let scheduleUpdate: { cron: string; timezone: string } | undefined;
  if (versioned) body.expectedVersion = number(single(args, "--expected-version"), 1, 2147483647);
  const org = single(args, "--org");
  if (action === "create") {
    const scope = single(args, "--scope") ?? "personal";
    if (scope !== "personal" && scope !== "org") throw invalid();
    if (org !== undefined && !args.options.has("--scope"))
      throw invalid("Create with --org requires explicit --scope personal|org.");
    Object.assign(body, { name: args.positionals[0], scope });
  }
  if (action === "create" || action === "update") {
    const file = single(args, "--file");
    let config: Record<string, unknown>;
    if (file !== undefined) {
      if (INLINE.some((key) => args.options.has(key)))
        throw invalid("Use either --file or inline configuration, not both.");
      try {
        const value: unknown = JSON.parse(await io.readFile(file));
        const fields = action === "create" ? CONFIG.filter((k) => k !== "name") : CONFIG;
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).some((k) => !fields.includes(k))
        )
          throw Error();
        config = value as Record<string, unknown>;
      } catch {
        throw invalid("Could not read supported routine configuration JSON from --file.");
      }
      if (action === "create") config.name = body.name;
    } else {
      if (action === "update") {
        scheduleUpdate = schedule(single(args, "--cron"), single(args, "--timezone"));
        config = {};
      } else {
        config = {
          name: body.name,
          templateId: single(args, "--template"),
          templateRevision: number(single(args, "--revision"), 1, 2147483647),
        };
        const prompt = single(args, "--prompt"),
          path = single(args, "--prompt-file");
        if ((prompt === undefined) === (path === undefined))
          throw invalid("Provide exactly one of --prompt or --prompt-file.");
        try {
          config.prompt = path === undefined ? prompt : await (path === "-" ? io.readStdin() : io.readFile(path));
        } catch {
          throw invalid("Could not read the routine prompt from --prompt-file.");
        }
        Object.assign(config, schedule(single(args, "--cron"), single(args, "--timezone")));
        if (args.options.has("--max-runs-per-day"))
          config.maxRunsPerDay = number(single(args, "--max-runs-per-day"), 1, 24);
        const ttl = single(args, "--ttl");
        if (ttl !== undefined) config.ttlSeconds = parseTtl(ttl);
      }
    }
    if (!scheduleUpdate) validate(config, action === "update");
    Object.assign(body, config);
  }
  const selected = org ?? (await io.auth.preferences?.read(armadaApiUrl(io.auth.env.ARMADA_URL)));
  if (!selected) throw invalid("Select an organization with --org NAME|UUID or armada org use.");
  if (UUID.test(selected)) body.org = selected;
  else {
    const { orgs } = await control<{ orgs: OrgSummary[] }>(io.auth, "org/list", {});
    const matches = orgs.filter((o) => o.name.toLowerCase() === selected.toLowerCase());
    if (matches.length !== 1 || !matches[0]) throw invalid("Choose an exact unambiguous organization name or UUID.");
    body.org = matches[0].id;
  }
  if (action !== "create" && action !== "list") {
    const target = args.positionals[0] ?? "";
    if (UUID.test(target)) body.id = target;
    else {
      const { items } = await control<{ items: Routine[] }>(io.auth, "routines/list", { org: body.org });
      const matches = items.filter((i) => i.name === target && i.status !== "deleted");
      if (matches.length !== 1 || !matches[0])
        throw invalid("Routine name not found or ambiguous. Use an exact name or ID.");
      body.id = matches[0].id;
    }
  }
  if (scheduleUpdate) {
    const { item } = await control<{ item: Routine }>(io.auth, "routines/get", { org: body.org, id: body.id });
    const config = {
      name: item.name,
      templateId: item.templateId,
      templateRevision: item.templateRevision,
      prompt: item.prompt,
      ttlSeconds: item.ttlSeconds,
      maxRunsPerDay: item.maxRunsPerDay,
      ...scheduleUpdate,
    };
    validate(config, true);
    Object.assign(body, config);
  }
  const route = ROUTES[action as keyof typeof ROUTES];
  const result = await control<Record<string, unknown>>(io.auth, `routines/${route}`, body);
  if (flag(args, "--json")) io.auth.out(`${JSON.stringify(result)}\n`);
  else if (action === "list") {
    const items = result.items as Routine[];
    io.auth.out(items.length ? `${items.map(format).join("\n")}\n` : "No routines.\n");
  } else if (action === "runs") {
    const items = result.items as Record<string, unknown>[];
    io.auth.out(
      items.length
        ? `${items.map((r) => `${r.id}  ${r.scheduledDueAt}  ${r.state}  task ${r.taskState ?? "not observed"}  ${r.reasonHelp ?? r.reason ?? ""}${r.taskHelp ? `  ${r.taskHelp}` : ""}${r.sandboxId ? `  sandbox ${r.sandboxId}` : ""}`).join("\n")}\n`
        : "No routine runs.\n",
    );
  } else {
    const item = result.item as Routine;
    io.auth.out(`${format(item)}\n`);
    if (action === "show")
      io.auth.out(
        `Template: ${item.templateId} revision ${item.templateRevision}\n${item.cron ? `Cron: ${item.cron}  Time zone: ${item.timezone}\n` : ""}TTL: ${item.ttlSeconds}s  Daily cap: ${item.maxRunsPerDay}\nConsecutive failures: ${item.consecutiveFailures}\nPause reason: ${routineReasonHelp(item.pauseReason) ?? "none"}\nPrompt:\n${item.prompt}\n`,
      );
    if (result.admittedRunsMayFinish)
      io.auth.err("Already admitted runs may still finish; running sandboxes were not stopped.\n");
  }
  return 0;
}
function number(value: unknown, min: number, max: number): number {
  const parsed = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw invalid("Routine limits, revisions and versions must be integers within the documented bounds.");
  return parsed;
}
function validate(config: Record<string, unknown>, full: boolean) {
  if (
    typeof config.name !== "string" ||
    !config.name.trim() ||
    config.name.length > 200 ||
    config.name.includes("\0") ||
    typeof config.templateId !== "string" ||
    !UUID.test(config.templateId)
  )
    throw invalid();
  if (typeof config.templateRevision !== "number") throw invalid();
  number(config.templateRevision, 1, 2147483647);
  if (
    typeof config.prompt !== "string" ||
    !config.prompt.trim() ||
    config.prompt.length > 32000 ||
    config.prompt.includes("\0")
  )
    throw invalid();
  schedule(config.cron, config.timezone);
  for (const [key, min, max] of [
    ["ttlSeconds", 300, 86400],
    ["maxRunsPerDay", 1, 24],
  ] as const) {
    if (full || config[key] !== undefined) {
      if (typeof config[key] !== "number") throw invalid();
      number(config[key], min, max);
    }
  }
}
function schedule(cron: unknown, timezone: unknown): { cron: string; timezone: string } {
  if (
    typeof cron !== "string" ||
    !cron.trim() ||
    cron.length > 200 ||
    cron.includes("\0") ||
    typeof timezone !== "string" ||
    !timezone.trim() ||
    timezone.length > 100 ||
    timezone.includes("\0")
  )
    throw invalid("Provide both --cron and --timezone, or cron and timezone in configuration JSON.");
  // The API is the only cron/calendar validator; the CLI never imports a server parser.
  return { cron, timezone };
}
function format(item: Routine): string {
  const words =
    item.scheduleDescription ??
    (item.intervalHours !== null && item.intervalHours !== undefined
      ? `Every ${item.intervalHours} hours (legacy UTC interval)`
      : `${item.cron ?? "Schedule unavailable"} (${item.timezone ?? "UTC"})`);
  const next = item.status === "enabled" ? (item.nextDueAt ?? "not scheduled") : `none (${item.status})`;
  return `${item.id}  ${item.name}  ${item.scope}  ${item.status}  version ${item.version}  ${words}  Next: ${next}`;
}
