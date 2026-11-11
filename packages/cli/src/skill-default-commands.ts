import { type OrgSummary, VaultError, validateSkillPins } from "@armada/core";
import { flag, parseArgs, single, values } from "./args.ts";
import { armadaApiUrl } from "./armada-api.ts";
import { control } from "./control.ts";
import type { VaultIo } from "./vault-commands.ts";

const HELP = `Default skills for future launches:
  armada skills defaults get [--scope personal|org|golden] [--golden-id UUID] [--org NAME|UUID] [--json]
  armada skills defaults set (--skill PIN ... | --clear) [--scope personal|org|golden] [--golden-id UUID] [--org NAME|UUID] [--json]

Scope defaults to personal. Golden scope requires --golden-id UUID; other scopes forbid it.
--org uses an exact, unambiguous name or UUID; omit it to use armada org use.
Set replaces the entire list. Repeat --skill for up to 20 distinct skill slugs, or use
--clear to explicitly remove every default. Missing pins never implicitly clear defaults.
Public pins are org/slug@1.2.3; private workspace pins are slug@1.2.3. Exact versions only.
No Skillpack or provider key is accepted here; the server resolves stored credentials.
Org members can read defaults; only admins change org or shared-golden defaults.
A private golden's owner changes its defaults. Personal defaults belong to you across organizations.
Merge precedence, low to high: environment, organization, personal, template, explicit launch pins.
A later layer replaces the pin for the same slug. Defaults affect future launches only.
armada launch --no-default-skills skips environment, org and personal defaults, retaining --skill pins.
`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new VaultError("invalid", "Invalid skill defaults command. Run armada skills defaults --help.");

// The server remains authoritative. This browser-safe policy rejects obvious invalid input before any HTTP.
function validPins(input: unknown): input is string[] {
  try {
    validateSkillPins(input);
    return true;
  } catch {
    return false;
  }
}

export async function skillDefaultsCommand(argv: readonly string[], io: VaultIo): Promise<number> {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    io.auth.out(HELP);
    return 0;
  }
  const input = parseInput(argv);
  const selected = input.org ?? (await io.auth.preferences?.read(armadaApiUrl(io.auth.env.ARMADA_URL)));
  if (!selected) throw new VaultError("invalid", "Select an organization with --org NAME|UUID or armada org use.");
  let org = selected;
  if (!UUID.test(org)) {
    const result = await control<{ orgs: OrgSummary[] }>(io.auth, "org/list", {});
    const matches = result.orgs.filter((entry) => entry.name.toLowerCase() === selected.toLowerCase());
    if (matches.length !== 1 || !matches[0])
      throw new VaultError("invalid", "Choose one of your organizations by UUID or exact unambiguous name.");
    org = matches[0].id;
  }
  const result = await control<unknown>(io.auth, `skills/defaults/${input.action}`, {
    org,
    scope: input.scope,
    ...(input.goldenId === undefined ? {} : { goldenId: input.goldenId }),
    ...(input.action === "set" ? { skills: input.skills } : {}),
  });
  const skills =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>).skills
      : undefined;
  if (!validPins(skills))
    throw new VaultError(
      "unavailable",
      "The server sent unreadable default skills. Reload before making further changes.",
    );
  io.auth.out(
    input.json
      ? `${JSON.stringify({ skills })}\n`
      : `${input.action === "set" ? "Updated default skills.\n" : ""}${skills.length ? `${skills.join("\n")}\n` : "No default skills configured.\n"}`,
  );
  return 0;
}

function parseInput(argv: readonly string[]) {
  try {
    const [resource, action, ...rest] = argv;
    if (resource !== "defaults" || (action !== "get" && action !== "set")) throw invalid();
    // parseArgs intentionally coalesces boolean options; singleton duplication is an error for this command.
    const seen = new Set<string>();
    for (const raw of rest) {
      if (!raw.startsWith("--")) continue;
      const key = raw.split("=")[0] ?? "";
      if (key !== "--skill" && seen.has(key)) throw invalid();
      seen.add(key);
    }
    const args = parseArgs(rest, ["--scope", "--golden-id", "--skill"], ["--clear"]);
    const allowed = new Set([
      "--scope",
      "--golden-id",
      "--org",
      "--json",
      ...(action === "set" ? ["--skill", "--clear"] : []),
    ]);
    if (args.positionals.length || [...args.options.keys()].some((key) => !allowed.has(key))) throw invalid();
    const scope = single(args, "--scope") ?? "personal";
    if (scope !== "personal" && scope !== "org" && scope !== "golden") throw invalid();
    const goldenId = single(args, "--golden-id");
    if (scope === "golden" ? !goldenId || !UUID.test(goldenId) : goldenId !== undefined) throw invalid();
    const skills = values(args, "--skill");
    if (action === "set" && (flag(args, "--clear") ? skills.length > 0 : skills.length === 0)) throw invalid();
    if (!validPins(skills)) throw invalid();
    return { action, scope, goldenId, skills, org: single(args, "--org"), json: flag(args, "--json") };
  } catch {
    throw invalid();
  }
}
