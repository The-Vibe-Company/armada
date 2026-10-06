// armada.toml v0: one project = one repository + one tracker program root.
// Secrets never live in this file; tokens come from the environment.
import { parse, TomlError } from "smol-toml";
import { failurePattern } from "./ci.ts";
import { JOB_NAME } from "./jobs.ts";
import { LINT_DEFAULTS, type LintRules } from "./lint.ts";
import { pathsProblem } from "./overlap.ts";

export interface JobConfig {
  start: string;
  status: string | null;
  stop: string;
  silenceMinutes: number;
  maxHours: number | null;
}

/** Shell environment names excluding object keys and Armada's command metadata. */
export function deployEnvName(name: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !["__proto__", "constructor", "prototype", "ARMADA_DEPLOY_SHA", "ARMADA_DEPLOY_TARGET"].includes(name)
  );
}

export interface DeployTarget {
  /** Repository-relative globs that trigger this target; omitted means every merge. */
  paths?: string[];
  requiresEnv?: string[];
  name: string;
  branch: string | null;
  githubEnvironment: string | null;
  liveShaCommand: string | null;
  smoke: string | null;
  timeoutMinutes: number;
  pauseOnFailure: boolean;
}

export interface CiConfig {
  failurePatterns: string[];
  knownFailures: { check: string; pattern: string; ticket: string }[];
}

export const CONFIG_FILE = "armada.toml";

export type SpecTitleStyle = "N" | "N/M";

export interface AcceptanceRule {
  name: string;
  command: string;
  paths: string[] | null;
  timeoutMinutes: number;
  maxRuns: number;
}

export interface ArmadaConfig {
  acceptance: AcceptanceRule[];
  jobs: Record<string, JobConfig>;
  project: {
    name: string;
    /** Stable identifier of the project, lowercase letters, digits and dashes. */
    slug: string;
  };
  tracker: {
    /** Identifier of the Linear issue at the root of the program, e.g. ABC-1. */
    programRoot: string;
    /** Style used when creating and renumbering specs; both forms are always readable. */
    specTitles: SpecTitleStyle;
    /** Explicit tracker.lint opts into errors; missing table uses warning-only defaults. */
    lint: LintRules;
    /** Language of owner-facing output (BCP 47 tag). Tracker comments stay in English. */
    language: string;
    /** Label that marks a ticket as specified enough for an agent to take. */
    readyLabel: string;
    /** Label that marks a ticket as parked on purpose: never listed as work to start. */
    parkedLabel: string;
    labels: {
      /** Single-select label group holding the agent phase. */
      phaseGroup: string;
      /** Single-select label group holding the agent runtime. */
      runtimeGroup: string;
      /** Values of the runtime group, one per agent runtime the fleet uses. */
      runtimes: string[];
    };
  };
  github: {
    /** owner/name */
    repository: string;
  };
  deploy?: { targets: DeployTarget[] };
  /** Signing policy for newly created Herdr worktrees; cloud environments keep their own policy. */
  git: { sign: "inherit" | "off" };
  ci: CiConfig;
  merge: {
    queueRetest: "ci" | "local";
    /** Repository path globs whose merges concern every working pull request. */
    notifyPaths: string[];
  };
  gates: {
    /**
     * CI checks that must be green on the head of a pull request before a
     * worker may hand it back. Empty: at least one check, and every check green.
     */
    requiredChecks: string[];
    /**
     * Shell commands `armada merge` runs on a test merge of a head that lacks
     * commits of its base branch (e.g. install, then lint and test). Empty:
     * such a head is refused until the worker brings the base branch in.
     */
    localCommands: string[];
  };
  policy: {
    /** A working agent with no heartbeat for longer than this shows as silent; old clients use reports. */
    silentAfterMinutes: number;
    launchGraceMinutes: number;
    ciWaitMinutes: number;
    quietAfterMinutes: number;
    /** An open item older than this in the coordinator's inbox shows "waiting for the coordinator" on the dashboard. */
    coordinatorMinutes: number;
    /** A launched worker that has not claimed its ticket after this long shows as not started. */
    notStartedMinutes: number;
    /** Whether a worker's plan waits for the coordinator's approval (`approve`) or not (`pre-approved`). */
    plans: PlanPolicy;
    /** A ticket carrying this label has its plan pre-approved, whatever `plans` says. */
    preApprovedLabel: string;
    /** A ticket carrying this label waits for approval, whatever `plans` says; it wins over `preApprovedLabel`. */
    approvalLabel: string;
    /** Image sample cap for owner validations, default four, at most eight. */
    validationSamples?: number;
    attachmentsPerTicket: number;
    attachmentsProjectMb: number;
    attachmentsRetentionDays: number;
    /**
     * `merge_approval`: which merges need the owner's approval, in plain words
     * (THE-885). The coordinator judges it per pull request; null: it merges
     * everything on its own.
     */
    mergeApproval: string | null;
    /** `[[policy.validation]]` in file order: kinds of tickets whose work the owner validates before it goes on. */
    validations: ValidationRule[];
  };
  reservations: { key: string; what: string; numbered: boolean }[];
  brief: {
    /** Repository path, relative to armada.toml, of a file every brief carries under "Project conventions"; null when unset. */
    extra: string | null;
  };
  secrets: {
    /**
     * Names of the secrets this project's workers expect (THE-859), e.g.
     * OPENAI_API_KEY: `armada doctor` says which are not set. Names only:
     * values live in Armada, never here.
     */
    names: string[];
  };
  conductor: {
    /** Optional explicit Conductor project and base branch for native launches. */
    projectId?: string | null;
    baseBranch?: string | null;
    /** Profile `armada brief` uses without `--profile`; null when none is declared. */
    defaultProfile: string | null;
    /** Launch settings by profile name, from `[conductor.profiles.<name>]`. */
    profiles: Record<string, ConductorProfile>;
    /** `[[conductor.routing]]` in file order: the first rule matching a ticket's labels picks its profile. */
    routing: RoutingRule[];
  };
  herdr: {
    /** Profile `armada launch --runtime herdr` uses without `--profile`; null when none is declared. */
    defaultProfile: string | null;
    /** Launch settings by profile name, from `[herdr.profiles.<name>]`. */
    profiles: Record<string, HerdrProfile>;
    /** `[[herdr.routing]]` in file order: the first rule matching a ticket's labels picks its profile. */
    routing: RoutingRule[];
  };
}

export const PLAN_POLICIES = ["approve", "pre-approved"] as const;
export type PlanPolicy = (typeof PLAN_POLICIES)[number];

/** How routing compares label names: case, spaces and punctuation ignored, letters (with their marks) of any script kept. */
export const routingLabelKey = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, "");

/**
 * A kind of ticket whose work the owner validates (THE-885): the coordinator
 * judges at launch whether `when` describes the ticket, and the worker then
 * does what `show` says (the file's `then`) and waits for the owner's decision.
 */
export interface ValidationRule {
  when: string;
  /** `then` in armada.toml, a name no object should carry in JavaScript (it would look like a promise). */
  show: string;
}

/** A ticket carrying any of `labels` goes to `profile`, unless an earlier rule matched. */
export interface RoutingRule {
  labels: string[];
  profile: string;
}

/** Where a profile's workers run, each with its runtime guide skill (`armada-runtime-<runtime>`). */
export const PROFILE_RUNTIMES = ["conductor", "claude-code"] as const;
export type ProfileRuntime = (typeof PROFILE_RUNTIMES)[number] | "herdr";

/** How a worker is launched: every value is passed explicitly, never left to the runtime's defaults. */
export interface ConductorProfile {
  when?: string;
  /** `conductor`: a Conductor workspace; `claude-code`: a subagent of the coordinator's Claude Code session. */
  runtime: ProfileRuntime;
  /** Conductor agent type, e.g. claude or codex (`conductor model` lists them); always claude for claude-code. */
  agent: string;
  /** Model id for that agent, e.g. opus-5-5-1m; for claude-code, what the Agent tool's `model` takes, e.g. opus. */
  model: string;
  /** Effort (thinking) level, e.g. high. Recorded only for claude-code: the Agent tool takes none. */
  effort: string;
  fastMode: boolean;
}

/** Harnesses Herdr can use to run a worker. */
export const HERDR_HARNESSES = ["claude", "codex", "opencode", "deepseek"] as const;
export type HerdrHarness = (typeof HERDR_HARNESSES)[number];

/** Permission policy for a Herdr profile; omitted means the harness's normal policy. */
export const HERDR_PERMISSIONS = ["ask", "full"] as const;
export type HerdrPermission = (typeof HERDR_PERMISSIONS)[number];

/** The native full-permission argument for each Herdr harness. */
export const HERDR_FULL_PERMISSION_ARGS: Record<HerdrHarness, string> = {
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  opencode: "--auto",
  deepseek: "--auto",
};

/** How a Herdr worker is launched. */
export interface HerdrProfile {
  when?: string;
  harness: HerdrHarness;
  model: string;
  effort: string;
  extraArgs: string[];
  /** Omitted: retain the harness's normal approval policy; full: use its native bypass/auto flag. */
  permissions?: HerdrPermission;
}

export const CONFIG_DEFAULTS = {
  notifyPaths: [".github/workflows/**"],
  gitSign: "inherit",
  language: "en",
  readyLabel: "ready-for-agent",
  parkedLabel: "parked",
  phaseGroup: "Agent phase",
  runtimeGroup: "Agent runtime",
  runtimes: ["Claude Code", "Codex", "Conductor", "Herdr"],
  silentAfterMinutes: 15,
  launchGraceMinutes: 15,
  ciWaitMinutes: 45,
  quietAfterMinutes: 45,
  coordinatorMinutes: 10,
  notStartedMinutes: 10,
  plans: "approve",
  preApprovedLabel: "plan-approved",
  approvalLabel: "needs-plan-approval",
  validationSamples: 4,
  attachmentsPerTicket: 20,
  attachmentsProjectMb: 200,
  attachmentsRetentionDays: 30,
} as const;

export class ConfigError extends Error {
  constructor(
    readonly source: string,
    readonly problems: string[],
  ) {
    super(`${source} is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ISSUE_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
/** A secret for workers: an environment variable name in upper snake case, as Armada keeps it (THE-859). */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Keys Armada itself reads: named and typed on the Keys page, never secrets for workers. */
const RESERVED_SECRET_NAMES = ["LINEAR_API_KEY", "GITHUB_TOKEN", "GH_TOKEN"];

/** Why `name` cannot be a secret for workers; null when it can. Quotes the name only when it is a name. */
export function secretNameRefusal(name: string): string | null {
  if (!SECRET_NAME.test(name)) return "a secret name is in upper snake case, e.g. OPENAI_API_KEY";
  if (RESERVED_SECRET_NAMES.includes(name) || name.startsWith("ARMADA_"))
    return `${name} is a key Armada itself uses: it is set on the Keys page as such, not as a secret for workers`;
  return null;
}
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses and validates armada.toml text. Throws ConfigError listing every problem by dotted key. */
export function parseConfig(text: string, source = CONFIG_FILE): ArmadaConfig {
  let raw: Table;
  try {
    raw = parse(text) as Table;
  } catch (err) {
    const where = err instanceof TomlError ? ` (line ${err.line}, column ${err.column})` : "";
    throw new ConfigError(source, [`not valid TOML${where}`]);
  }

  const problems: string[] = [];
  const table = (key: string): Table => {
    const v = raw[key];
    if (v === undefined) {
      problems.push(`missing required table [${key}]`);
      return {};
    }
    if (!isTable(v)) {
      problems.push(`"${key}" must be a table`);
      return {};
    }
    return v;
  };
  const str = (
    t: Table,
    path: string,
    key: string,
    opts: { default?: string; pattern?: RegExp; hint?: string } = {},
  ) => {
    const v = t[key];
    const dotted = `${path}.${key}`;
    if (v === undefined) {
      if (opts.default !== undefined) return opts.default;
      problems.push(`missing required key "${dotted}"`);
      return "";
    }
    if (typeof v !== "string" || !v.trim()) {
      problems.push(`"${dotted}" must be a non-empty string`);
      return "";
    }
    if (opts.pattern && !opts.pattern.test(v)) {
      problems.push(`"${dotted}" is "${v}", expected ${opts.hint}`);
      return "";
    }
    return v.trim();
  };

  const project = table("project");
  const tracker = table("tracker");
  const github = table("github");
  const labels = tracker.labels === undefined ? {} : tracker.labels;
  if (!isTable(labels)) problems.push(`"tracker.labels" must be a table`);
  const policy = raw.policy === undefined ? {} : raw.policy;
  if (!isTable(policy)) problems.push(`"policy" must be a table`);
  const lintRaw = tracker.lint;
  if (lintRaw !== undefined && !isTable(lintRaw)) problems.push('"tracker.lint" must be a table');
  const lintT = isTable(lintRaw) ? lintRaw : {};
  const inShort = str(lintT, "tracker.lint", "in_short", { default: LINT_DEFAULTS.inShort });
  if (!/^#{1,6} [^\r\n]+$/.test(inShort))
    problems.push('"tracker.lint.in_short" must be a Markdown heading, e.g. "## In short"');
  let inShortParts = [...LINT_DEFAULTS.inShortParts];
  if (lintT.in_short_parts !== undefined) {
    const parts = lintT.in_short_parts;
    if (
      Array.isArray(parts) &&
      parts.length > 0 &&
      parts.every((p) => typeof p === "string" && p.trim() && !/[\r\n]/.test(p))
    )
      inShortParts = [...new Set(parts.map((p: string) => p.trim()))];
    else problems.push('"tracker.lint.in_short_parts" must be a non-empty list of part names on one line');
  }
  let titleMax = LINT_DEFAULTS.titleMax;
  if (lintT.title_max !== undefined) {
    const max = lintT.title_max;
    if (typeof max === "number" && Number.isSafeInteger(max) && max > 0) titleMax = max;
    else problems.push('"tracker.lint.title_max" must be a positive integer');
  }
  const lint: LintRules = { inShort, inShortParts, titleMax, severity: lintRaw === undefined ? "warning" : "error" };
  const labelsT = isTable(labels) ? labels : {};
  const policyT = isTable(policy) ? policy : {};
  const git = raw.git ?? {};
  if (!isTable(git)) problems.push('"git" must be a table');
  const gitT = isTable(git) ? git : {};
  const sign = gitT.sign ?? CONFIG_DEFAULTS.gitSign;
  if (sign !== "inherit" && sign !== "off") problems.push('"git.sign" must be "inherit" or "off"');
  const ci = raw.ci ?? {};
  if (!isTable(ci)) problems.push(`"ci" must be a table`);
  const ciT = isTable(ci) ? ci : {};
  const gates = raw.gates === undefined ? {} : raw.gates;
  if (!isTable(gates)) problems.push(`"gates" must be a table`);
  const gatesT = isTable(gates) ? gates : {};
  const merge = raw.merge === undefined ? {} : raw.merge;
  if (!isTable(merge)) problems.push(`"merge" must be a table`);
  const mergeT = isTable(merge) ? merge : {};
  const brief = raw.brief === undefined ? {} : raw.brief;
  if (!isTable(brief)) problems.push(`"brief" must be a table`);
  const briefT = isTable(brief) ? brief : {};
  const secrets = raw.secrets === undefined ? {} : raw.secrets;
  if (!isTable(secrets)) problems.push(`"secrets" must be a table`);
  const secretsT = isTable(secrets) ? secrets : {};
  const conductor = raw.conductor === undefined ? {} : raw.conductor;
  if (!isTable(conductor)) problems.push(`"conductor" must be a table`);
  const conductorT = isTable(conductor) ? conductor : {};
  const profilesRaw = conductorT.profiles === undefined ? {} : conductorT.profiles;
  if (!isTable(profilesRaw)) problems.push(`"conductor.profiles" must be a table of profiles`);
  const profilesT = isTable(profilesRaw) ? profilesRaw : {};
  const herdr = raw.herdr === undefined ? {} : raw.herdr;
  if (!isTable(herdr)) problems.push(`"herdr" must be a table`);
  const herdrT = isTable(herdr) ? herdr : {};
  const herdrProfilesRaw = herdrT.profiles === undefined ? {} : herdrT.profiles;
  if (!isTable(herdrProfilesRaw)) problems.push(`"herdr.profiles" must be a table of profiles`);
  const herdrProfilesT = isTable(herdrProfilesRaw) ? herdrProfilesRaw : {};

  // Unknown keys inside known tables are typos; unknown top-level tables are
  // left alone so newer sections do not break older readers.
  const known: [string, Table, string[]][] = [
    ["project", project, ["name", "slug"]],
    ["tracker", tracker, ["program_root", "spec_titles", "language", "ready_label", "parked_label", "labels", "lint"]],
    ["tracker.lint", lintT, ["in_short", "in_short_parts", "title_max"]],
    ["tracker.labels", labelsT, ["phase_group", "runtime_group", "runtimes"]],
    ["github", github, ["repository"]],
    ["git", gitT, ["sign"]],
    ["ci", ciT, ["failure_patterns", "known_failure"]],
    ["gates", gatesT, ["required_checks", "local_commands"]],
    ["merge", mergeT, ["notify_paths", "queue_retest"]],
    [
      "policy",
      policyT,
      [
        "silence_minutes",
        "launch_grace_minutes",
        "ci_wait_minutes",
        "quiet_minutes",
        "silent_after_minutes",
        "coordinator_minutes",
        "not_started_minutes",
        "plans",
        "pre_approved_label",
        "approval_label",
        "attachments_per_ticket",
        "attachments_project_mb",
        "attachments_retention_days",
        "validation_samples",
        "merge_approval",
        "validation",
      ],
    ],
    ["brief", briefT, ["extra"]],
    ["secrets", secretsT, ["names"]],
    ["conductor", conductorT, ["default_profile", "profiles", "routing", "project_id", "base_branch"]],
    ["herdr", herdrT, ["default_profile", "profiles", "routing"]],
  ];
  const profiles: Record<string, ConductorProfile> = {};
  for (const [name, p] of Object.entries(profilesT)) {
    const path = `conductor.profiles.${name}`;
    if (!isTable(p)) {
      problems.push(`"${path}" must be a table`);
      continue;
    }
    if (name === "__proto__") {
      problems.push(`"${path}" is not a usable profile name`);
      continue;
    }
    known.push([path, p, ["runtime", "agent", "model", "effort", "fast_mode", "when"]]);
    if (p.fast_mode !== undefined && typeof p.fast_mode !== "boolean")
      problems.push(`"${path}.fast_mode" must be true or false`);
    const runtime = p.runtime ?? "conductor";
    if (!PROFILE_RUNTIMES.includes(runtime as (typeof PROFILE_RUNTIMES)[number]))
      problems.push(`"${path}.runtime" must be one of ${PROFILE_RUNTIMES.map((r) => `"${r}"`).join(", ")}`);
    if (runtime === "claude-code" && p.agent !== undefined && p.agent !== "claude")
      problems.push(`"${path}.agent" must be "claude" with runtime = "claude-code"`);
    profiles[name] = {
      ...(p.when !== undefined ? { when: str(p, path, "when") } : {}),
      runtime: PROFILE_RUNTIMES.includes(runtime as (typeof PROFILE_RUNTIMES)[number])
        ? (runtime as ProfileRuntime)
        : "conductor",
      agent: str(p, path, "agent"),
      model: str(p, path, "model"),
      effort: str(p, path, "effort"),
      fastMode: p.fast_mode === true,
    };
  }
  let defaultProfile: string | null = null;
  if (conductorT.default_profile !== undefined) {
    defaultProfile = str(conductorT, "conductor", "default_profile") || null;
    if (defaultProfile && !Object.hasOwn(profiles, defaultProfile))
      problems.push(
        `"conductor.default_profile" is "${defaultProfile}", but there is no [conductor.profiles.${defaultProfile}]`,
      );
  }
  const projectId =
    conductorT.project_id === undefined
      ? null
      : str(conductorT, "conductor", "project_id", {
          pattern: /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/,
          hint: "a Conductor project id",
        });
  const baseBranch =
    conductorT.base_branch === undefined
      ? null
      : str(conductorT, "conductor", "base_branch", {
          pattern:
            /^(?![-/.])(?!.*\/\.)(?!.*\.lock(?:\/|$))(?!.*[\s~^:?*[\\])(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*\/$)(?!.*\.$)(?!.*\.lock$)[^\s]+$/,
          hint: "a git branch name",
        });
  if (baseBranch && [...baseBranch].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    problems.push('"conductor.base_branch" must be a git branch name');
  const routing: RoutingRule[] = [];
  const routingRaw = conductorT.routing ?? [];
  if (!Array.isArray(routingRaw)) problems.push(`"conductor.routing" must be a list of [[conductor.routing]] rules`);
  else
    for (const [i, r] of routingRaw.entries()) {
      const path = `conductor.routing[${i + 1}]`;
      if (!isTable(r)) {
        problems.push(`"${path}" must be a table`);
        continue;
      }
      known.push([path, r, ["labels", "profile"]]);
      const labels = r.labels;
      const ok =
        Array.isArray(labels) && labels.length && labels.every((l) => typeof l === "string" && routingLabelKey(l));
      if (!ok)
        problems.push(`"${path}.labels" must be a non-empty list of Linear label names, each with a letter or digit`);
      const profile = str(r, path, "profile");
      if (profile && !Object.hasOwn(profiles, profile))
        problems.push(`"${path}.profile" is "${profile}", but there is no [conductor.profiles.${profile}]`);
      if (ok && profile) routing.push({ labels: labels.map((l: string) => l.trim()), profile });
    }
  if (
    Array.isArray(routingRaw) &&
    routingRaw.length &&
    conductorT.default_profile === undefined &&
    !Object.values(profiles).some((profile) => profile.when)
  )
    problems.push(`"conductor.default_profile" is required with [[conductor.routing]], for tickets no rule matches`);

  const herdrProfiles: Record<string, HerdrProfile> = {};
  for (const [name, p] of Object.entries(herdrProfilesT)) {
    const path = `herdr.profiles.${name}`;
    if (!isTable(p)) {
      problems.push(`"${path}" must be a table`);
      continue;
    }
    if (name === "__proto__") {
      problems.push(`"${path}" is not a usable profile name`);
      continue;
    }
    known.push([path, p, ["harness", "model", "effort", "extra_args", "permissions", "when"]]);

    let harness: HerdrHarness = "claude";
    if (p.harness === undefined) problems.push(`missing required key "${path}.harness"`);
    else if (HERDR_HARNESSES.includes(p.harness as HerdrHarness)) harness = p.harness as HerdrHarness;
    else problems.push(`"${path}.harness" must be one of ${HERDR_HARNESSES.map((h) => `"${h}"`).join(", ")}`);

    let extraArgs: string[] = [];
    if (p.extra_args !== undefined) {
      if (Array.isArray(p.extra_args) && p.extra_args.every((arg) => typeof arg === "string" && arg.trim()))
        extraArgs = [...p.extra_args];
      else problems.push(`"${path}.extra_args" must be a list of non-empty argument strings`);
    }
    if (harness === "deepseek" && extraArgs.some((arg) => /^(?:--model(?:=|$)|-m)/.test(arg.trim())))
      problems.push(`"${path}.extra_args" must not override the DeepSeek model; use "${path}.model"`);
    let permissions: HerdrPermission | undefined;
    if (p.permissions !== undefined) {
      if (HERDR_PERMISSIONS.includes(p.permissions as HerdrPermission)) permissions = p.permissions as HerdrPermission;
      else problems.push(`"${path}.permissions" must be "ask" or "full"`);
    }
    if (permissions === "ask" && extraArgs.some((arg) => arg.trim() === HERDR_FULL_PERMISSION_ARGS[harness]))
      problems.push(
        `"${path}.permissions" = "ask" cannot be combined with "${HERDR_FULL_PERMISSION_ARGS[harness]}" in "${path}.extra_args"`,
      );
    const model =
      (harness === "opencode" || harness === "deepseek") &&
      (p.model === undefined || (typeof p.model === "string" && !p.model.trim()))
        ? ""
        : str(p, path, "model");
    herdrProfiles[name] = {
      ...(p.when !== undefined ? { when: str(p, path, "when") } : {}),
      harness,
      model,
      effort: str(p, path, "effort"),
      extraArgs,
      ...(permissions !== undefined ? { permissions } : {}),
    };
  }
  let herdrDefaultProfile: string | null = null;
  if (herdrT.default_profile !== undefined) {
    herdrDefaultProfile = str(herdrT, "herdr", "default_profile") || null;
    if (herdrDefaultProfile && !Object.hasOwn(herdrProfiles, herdrDefaultProfile))
      problems.push(
        `"herdr.default_profile" is "${herdrDefaultProfile}", but there is no [herdr.profiles.${herdrDefaultProfile}]`,
      );
  }
  const herdrRouting: RoutingRule[] = [];
  const herdrRoutingRaw = herdrT.routing ?? [];
  if (!Array.isArray(herdrRoutingRaw)) problems.push(`"herdr.routing" must be a list of [[herdr.routing]] rules`);
  else
    for (const [i, r] of herdrRoutingRaw.entries()) {
      const path = `herdr.routing[${i + 1}]`;
      if (!isTable(r)) {
        problems.push(`"${path}" must be a table`);
        continue;
      }
      known.push([path, r, ["labels", "profile"]]);
      const labels = r.labels;
      const ok =
        Array.isArray(labels) && labels.length && labels.every((l) => typeof l === "string" && routingLabelKey(l));
      if (!ok)
        problems.push(`"${path}.labels" must be a non-empty list of Linear label names, each with a letter or digit`);
      const profile = str(r, path, "profile");
      if (profile && !Object.hasOwn(herdrProfiles, profile))
        problems.push(`"${path}.profile" is "${profile}", but there is no [herdr.profiles.${profile}]`);
      if (ok && profile) herdrRouting.push({ labels: labels.map((l: string) => l.trim()), profile });
    }
  if (
    Array.isArray(herdrRoutingRaw) &&
    herdrRoutingRaw.length &&
    herdrT.default_profile === undefined &&
    !Object.values(herdrProfiles).some((profile) => profile.when)
  )
    problems.push(`"herdr.default_profile" is required with [[herdr.routing]], for tickets no rule matches`);
  const acceptance: AcceptanceRule[] = [];
  if (raw.acceptance !== undefined && !Array.isArray(raw.acceptance))
    problems.push('"acceptance" must be an array of tables');
  for (const [i, row] of (Array.isArray(raw.acceptance) ? raw.acceptance : []).entries()) {
    const path = `acceptance.${i}`;
    if (!isTable(row)) {
      problems.push(`"${path}" must be a table`);
      continue;
    }
    known.push([path, row, ["name", "command", "paths", "timeout_minutes", "max_runs"]]);
    const name = str(row, path, "name");
    if ([...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || name.length > 200)
      problems.push(`"${path}.name" must be a single line of at most 200 characters`);
    if (acceptance.some((r) => r.name === name)) problems.push(`"${path}.name" repeats ${name}`);
    const limit = (key: string, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
      const v = row[key] ?? fallback;
      if (typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= max) return v;
      problems.push(`"${path}.${key}" must be a positive integer at most ${max}`);
      return fallback;
    };
    const paths = row.paths === undefined ? null : row.paths;
    if (paths !== null) {
      const problem = pathsProblem(paths);
      if (problem || (Array.isArray(paths) && !paths.length))
        problems.push(`"${path}.paths": ${problem ?? "must not be empty"}`);
    }
    acceptance.push({
      name,
      command: str(row, path, "command"),
      paths: Array.isArray(paths) ? paths : null,
      timeoutMinutes: limit("timeout_minutes", 15, 120),
      maxRuns: limit("max_runs", 3),
    });
  }
  const deployRaw = raw.deploy ?? {};
  if (!isTable(deployRaw)) problems.push('"deploy" must be a table');
  const deployT = isTable(deployRaw) ? deployRaw : {};
  known.push(["deploy", deployT, ["target"]]);
  const deployTargets: DeployTarget[] = [];
  if (deployT.target !== undefined && !Array.isArray(deployT.target))
    problems.push('"deploy.target" must be an array of tables');
  for (const [i, row] of (Array.isArray(deployT.target) ? deployT.target : []).entries()) {
    const path = `deploy.target.${i}`;
    if (!isTable(row)) {
      problems.push(`"${path}" must be a table`);
      continue;
    }
    known.push([
      path,
      row,
      [
        "name",
        "branch",
        "paths",
        "requires_env",
        "github_environment",
        "live_sha_command",
        "smoke",
        "timeout_minutes",
        "pause_on_failure",
      ],
    ]);
    const name = str(row, path, "name");
    if (name.length > 200) problems.push(`"${path}.name" has at most 200 characters`);
    if (deployTargets.some((t) => t.name === name)) problems.push(`"${path}.name" repeats ${name}`);
    const optional = (key: string) => (row[key] === undefined ? null : str(row, path, key));
    const githubEnvironment = optional("github_environment");
    const liveShaCommand = optional("live_sha_command");
    if ((githubEnvironment === null) === (liveShaCommand === null))
      problems.push(`"${path}" needs exactly one of github_environment or live_sha_command`);
    const timeoutMinutes = row.timeout_minutes ?? 20;
    if (
      typeof timeoutMinutes !== "number" ||
      !Number.isFinite(timeoutMinutes) ||
      timeoutMinutes < 1 ||
      timeoutMinutes > 120
    )
      problems.push(`"${path}.timeout_minutes" must be from 1 to 120`);
    if (row.pause_on_failure !== undefined && typeof row.pause_on_failure !== "boolean")
      problems.push(`"${path}.pause_on_failure" must be true or false`);
    if (row.paths !== undefined) {
      const problem = pathsProblem(row.paths);
      if (problem || (Array.isArray(row.paths) && !row.paths.length))
        problems.push(`"${path}.paths": ${problem ?? "must not be empty"}`);
    }
    if (
      row.requires_env !== undefined &&
      (!Array.isArray(row.requires_env) ||
        row.requires_env.some((name) => typeof name !== "string" || !deployEnvName(name)))
    )
      problems.push(`"${path}.requires_env" must be an array of environment variable names (excluding reserved names)`);
    deployTargets.push({
      ...(Array.isArray(row.requires_env) ? { requiresEnv: [...new Set(row.requires_env)] } : {}),
      ...(Array.isArray(row.paths) ? { paths: row.paths } : {}),
      name,
      branch: optional("branch"),
      githubEnvironment,
      liveShaCommand,
      smoke: optional("smoke"),
      timeoutMinutes: typeof timeoutMinutes === "number" ? timeoutMinutes : 20,
      pauseOnFailure: row.pause_on_failure !== false,
    });
  }

  const jobs: Record<string, JobConfig> = {};
  const jobsRaw = raw.jobs ?? {};
  if (!isTable(jobsRaw)) problems.push('"jobs" must be a table of job definitions');
  else
    for (const [name, j] of Object.entries(jobsRaw)) {
      const path = `jobs.${name}`;
      if (!JOB_NAME.test(name) || name === "__proto__") {
        problems.push(`"${path}" is not a usable job name`);
        continue;
      }
      if (!isTable(j)) {
        problems.push(`"${path}" must be a table`);
        continue;
      }
      known.push([path, j, ["start", "status", "stop", "silence_minutes", "max_hours"]]);
      const positive = (key: string, fallback: number | null): number | null => {
        const v = j[key];
        if (v === undefined) return fallback;
        if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
        problems.push(`"${path}.${key}" must be a positive number`);
        return fallback;
      };
      jobs[name] = {
        start: str(j, path, "start"),
        status: j.status === undefined ? null : str(j, path, "status"),
        stop: str(j, path, "stop"),
        silenceMinutes: positive("silence_minutes", 15) ?? 15,
        maxHours: positive("max_hours", null),
      };
    }
  for (const [path, t, keys] of known)
    for (const key of Object.keys(t)) if (!keys.includes(key)) problems.push(`unknown key "${path}.${key}"`);

  let runtimes: string[] = [...CONFIG_DEFAULTS.runtimes];
  if (labelsT.runtimes !== undefined) {
    const v = labelsT.runtimes;
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string" && x.trim()))
      runtimes = [...new Set(v.map((x: string) => x.trim()))];
    else problems.push(`"tracker.labels.runtimes" must be a non-empty list of names`);
  }

  // `silent_after_minutes` is the first name of `silence_minutes`, still accepted.
  const silenceKey = policyT.silence_minutes !== undefined ? "silence_minutes" : "silent_after_minutes";
  if (policyT.silence_minutes !== undefined && policyT.silent_after_minutes !== undefined)
    problems.push(`"policy.silent_after_minutes" is the old name of "policy.silence_minutes"; keep only one`);
  let silentAfterMinutes: number = CONFIG_DEFAULTS.silentAfterMinutes;
  if (policyT[silenceKey] !== undefined) {
    const v = policyT[silenceKey];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) silentAfterMinutes = v;
    else problems.push(`"policy.${silenceKey}" must be a positive number`);
  }
  const allowance = (key: string, fallback: number, zero = false): number => {
    const value = policyT[key];
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isFinite(value) && (zero ? value >= 0 : value > 0)) return value;
    problems.push(`"policy.${key}" must be a ${zero ? "nonnegative" : "positive"} number`);
    return fallback;
  };
  const launchGraceMinutes = allowance("launch_grace_minutes", silentAfterMinutes, true);
  const ciWaitMinutes = allowance("ci_wait_minutes", CONFIG_DEFAULTS.ciWaitMinutes);
  let coordinatorMinutes: number = CONFIG_DEFAULTS.coordinatorMinutes;
  let quietAfterMinutes: number = CONFIG_DEFAULTS.quietAfterMinutes;
  if (policyT.quiet_minutes !== undefined) {
    const value = policyT.quiet_minutes;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) quietAfterMinutes = value;
    else problems.push('"policy.quiet_minutes" must be a positive number');
  }
  if (policyT.coordinator_minutes !== undefined) {
    const v = policyT.coordinator_minutes;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) coordinatorMinutes = v;
    else problems.push(`"policy.coordinator_minutes" must be a positive number`);
  }
  let notStartedMinutes: number = CONFIG_DEFAULTS.notStartedMinutes;
  if (policyT.not_started_minutes !== undefined) {
    const v = policyT.not_started_minutes;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) notStartedMinutes = v;
    else problems.push(`"policy.not_started_minutes" must be a positive number`);
  }

  let plans: PlanPolicy = CONFIG_DEFAULTS.plans;
  if (policyT.plans !== undefined) {
    const v = policyT.plans;
    if (typeof v === "string" && (PLAN_POLICIES as readonly string[]).includes(v.trim()))
      plans = v.trim() as PlanPolicy;
    else problems.push(`"policy.plans" must be ${PLAN_POLICIES.map((p) => `"${p}"`).join(" or ")}`);
  }
  const preApprovedLabel = str(policyT, "policy", "pre_approved_label", { default: CONFIG_DEFAULTS.preApprovedLabel });
  const quota = (key: string, fallback: number): number => {
    const value = policyT[key];
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
    problems.push(`"policy.${key}" must be a positive integer`);
    return fallback;
  };
  const validationSamples = quota("validation_samples", CONFIG_DEFAULTS.validationSamples);
  if (validationSamples > 8) problems.push('"policy.validation_samples" must be at most 8');
  const attachmentsPerTicket = quota("attachments_per_ticket", CONFIG_DEFAULTS.attachmentsPerTicket);
  const attachmentsProjectMb = quota("attachments_project_mb", CONFIG_DEFAULTS.attachmentsProjectMb);
  const attachmentsRetentionDays = quota("attachments_retention_days", CONFIG_DEFAULTS.attachmentsRetentionDays);
  const mergeApproval = policyT.merge_approval === undefined ? null : str(policyT, "policy", "merge_approval") || null;
  const validations: ValidationRule[] = [];
  const validationRaw = policyT.validation ?? [];
  if (!Array.isArray(validationRaw)) problems.push(`"policy.validation" must be a list of [[policy.validation]] rules`);
  else
    for (const [i, r] of validationRaw.entries()) {
      const path = `policy.validation[${i + 1}]`;
      if (!isTable(r)) {
        problems.push(`"${path}" must be a table`);
        continue;
      }
      for (const key of Object.keys(r))
        if (key !== "when" && key !== "then") problems.push(`unknown key "${path}.${key}"`);
      const when = str(r, path, "when");
      const then = str(r, path, "then");
      if (when && then) validations.push({ when, show: then });
    }
  const approvalLabel = str(policyT, "policy", "approval_label", { default: CONFIG_DEFAULTS.approvalLabel });
  if (preApprovedLabel && approvalLabel && routingLabelKey(preApprovedLabel) === routingLabelKey(approvalLabel))
    problems.push(`"policy.pre_approved_label" and "policy.approval_label" must name different labels`);

  let extra: string | null = null;
  if (briefT.extra !== undefined) {
    const v = str(briefT, "brief", "extra");
    if (v && (v.startsWith("/") || v.split(/[\\/]/).includes("..")))
      problems.push(`"brief.extra" is "${v}", expected a path inside the repository, relative to ${CONFIG_FILE}`);
    else if (v) extra = v;
  }

  let secretNames: string[] = [];
  if (secretsT.names !== undefined) {
    const v = secretsT.names;
    if (Array.isArray(v) && v.every((n) => typeof n === "string" && !secretNameRefusal(n.trim())))
      secretNames = [...new Set(v.map((n: string) => n.trim()))];
    else
      problems.push(
        `"secrets.names" must be a list of secret names in upper snake case, e.g. ["OPENAI_API_KEY"], none of Armada's own keys`,
      );
  }

  let requiredChecks: string[] = [];
  if (gatesT.required_checks !== undefined) {
    const v = gatesT.required_checks;
    if (Array.isArray(v) && v.every((c) => typeof c === "string" && c.trim()))
      requiredChecks = [...new Set(v.map((c: string) => c.trim()))];
    else problems.push(`"gates.required_checks" must be a list of check names`);
  }

  let localCommands: string[] = [];
  if (gatesT.local_commands !== undefined) {
    const v = gatesT.local_commands;
    if (Array.isArray(v) && v.every((c) => typeof c === "string" && c.trim()))
      localCommands = v.map((c: string) => c.trim());
    else problems.push(`"gates.local_commands" must be a list of shell commands`);
  }

  let failurePatterns: string[] = [];
  if (ciT.failure_patterns !== undefined) {
    const v = ciT.failure_patterns;
    if (Array.isArray(v) && v.every((p) => typeof p === "string" && p.trim())) {
      failurePatterns = [...new Set(v)];
      for (const [i, pattern] of failurePatterns.entries()) {
        try {
          failurePattern(pattern);
        } catch {
          problems.push(
            `"ci.failure_patterns[${i + 1}]" must be a valid regex with exactly one capture group for the test name`,
          );
        }
      }
    } else problems.push(`"ci.failure_patterns" must be a list of non-empty regex strings`);
  }

  const queueRetest = mergeT.queue_retest ?? "ci";
  if (queueRetest !== "ci" && queueRetest !== "local") problems.push('"merge.queue_retest" must be "ci" or "local"');

  let notifyPaths: string[] = [...CONFIG_DEFAULTS.notifyPaths];
  if (mergeT.notify_paths !== undefined) {
    const v = mergeT.notify_paths;
    if (Array.isArray(v) && v.every((p) => typeof p === "string" && p.trim() && !p.includes("\u0000")))
      notifyPaths = [...new Set(v.map((p: string) => p.trim()))];
    else problems.push(`"merge.notify_paths" must be a list of path globs`);
  }

  const knownFailures: CiConfig["knownFailures"] = [];
  if (ciT.known_failure !== undefined) {
    if (!Array.isArray(ciT.known_failure)) problems.push('"ci.known_failure" must be an array of tables');
    else
      for (const [i, entry] of ciT.known_failure.entries()) {
        const path = `ci.known_failure[${i + 1}]`;
        if (!isTable(entry)) {
          problems.push(`"${path}" must be a table`);
          continue;
        }
        for (const key of Object.keys(entry))
          if (!["check", "pattern", "ticket"].includes(key)) problems.push(`unknown key "${path}.${key}"`);
        const check = str(entry, path, "check");
        const pattern = str(entry, path, "pattern");
        const ticket = str(entry, path, "ticket", { pattern: ISSUE_ID, hint: "an issue identifier such as ABC-1" });
        try {
          new RegExp(pattern);
        } catch {
          problems.push(`"${path}.pattern" must be a valid regex`);
        }
        knownFailures.push({ check, pattern, ticket });
      }
  }

  let specTitles: SpecTitleStyle = "N";
  if (tracker.spec_titles !== undefined) {
    if (tracker.spec_titles === "N" || tracker.spec_titles === "N/M") specTitles = tracker.spec_titles;
    else problems.push('"tracker.spec_titles" must be "N" or "N/M"');
  }

  const reservations: ArmadaConfig["reservations"] = [];
  if (raw.reservations !== undefined && !Array.isArray(raw.reservations))
    problems.push('"reservations" must be an array of tables');
  for (const [i, row] of (Array.isArray(raw.reservations) ? raw.reservations : []).entries()) {
    const path = `reservations.${i}`;
    if (!isTable(row)) {
      problems.push(`"${path}" must be a table`);
      continue;
    }
    for (const key of Object.keys(row))
      if (!["key", "what", "numbered"].includes(key)) problems.push(`"${path}.${key}" is unknown`);
    const key = str(row, path, "key");
    const what = str(row, path, "what");
    if (key.length > 500) problems.push(`"${path}.key" has at most 500 characters`);
    if (reservations.some((r) => r.key === key)) problems.push(`"${path}.key" repeats ${key}`);
    if (row.numbered !== undefined && typeof row.numbered !== "boolean")
      problems.push(`"${path}.numbered" must be true or false`);
    reservations.push({ key, what, numbered: row.numbered === true });
  }
  const config: ArmadaConfig = {
    acceptance,
    jobs,
    project: {
      name: str(project, "project", "name"),
      slug: str(project, "project", "slug", { pattern: SLUG, hint: "lowercase letters, digits and dashes" }),
    },
    tracker: {
      specTitles,
      lint,
      programRoot: str(tracker, "tracker", "program_root", {
        pattern: ISSUE_ID,
        hint: "an issue identifier such as ABC-1",
      }),
      language: str(tracker, "tracker", "language", { default: CONFIG_DEFAULTS.language }),
      readyLabel: str(tracker, "tracker", "ready_label", { default: CONFIG_DEFAULTS.readyLabel }),
      parkedLabel: str(tracker, "tracker", "parked_label", { default: CONFIG_DEFAULTS.parkedLabel }),
      labels: {
        phaseGroup: str(labelsT, "tracker.labels", "phase_group", { default: CONFIG_DEFAULTS.phaseGroup }),
        runtimeGroup: str(labelsT, "tracker.labels", "runtime_group", { default: CONFIG_DEFAULTS.runtimeGroup }),
        runtimes,
      },
    },
    github: {
      repository: str(github, "github", "repository", { pattern: REPOSITORY, hint: "owner/name" }),
    },
    ...(raw.deploy === undefined ? {} : { deploy: { targets: deployTargets } }),
    git: { sign: sign === "off" ? "off" : "inherit" },
    ci: { failurePatterns, knownFailures },
    gates: { requiredChecks, localCommands },
    merge: { notifyPaths, queueRetest: queueRetest === "local" ? "local" : "ci" },
    policy: {
      silentAfterMinutes,
      launchGraceMinutes,
      ciWaitMinutes,
      quietAfterMinutes,
      coordinatorMinutes,
      notStartedMinutes,
      plans,
      preApprovedLabel,
      approvalLabel,
      validationSamples,
      attachmentsPerTicket,
      attachmentsProjectMb,
      attachmentsRetentionDays,
      mergeApproval,
      validations,
    },
    reservations,
    brief: { extra },
    secrets: { names: secretNames },
    conductor: {
      defaultProfile,
      profiles,
      routing,
      ...(projectId ? { projectId } : {}),
      ...(baseBranch ? { baseBranch } : {}),
    },
    herdr: { defaultProfile: herdrDefaultProfile, profiles: herdrProfiles, routing: herdrRouting },
  };
  if (problems.length) throw new ConfigError(source, problems);
  config.tracker.programRoot = config.tracker.programRoot.toUpperCase();
  return config;
}

/** A commented armada.toml for a new project; `parseConfig` accepts it as is. */
export function configTemplate(p: { name: string; slug: string; programRoot: string; repository: string }): string {
  const q = JSON.stringify;
  return `# Armada configuration: one project = one repository + one tracker program root.
# No secrets here: sign in with \`armada login\`; set worker secrets on Organization > Keys.

[project]
name = ${q(p.name)}
slug = ${q(p.slug)}          # stable id: lowercase letters, digits and dashes

[tracker]
program_root = ${q(p.programRoot)}  # Linear issue at the root of the program
spec_titles = "N"       # "N/M" keeps totals and updates them when adding a spec
language = "en"          # language of owner-facing output
ready_label = "ready-for-agent"
# parked_label = "parked"  # a ticket with this label is parked on purpose: never listed as work to start

[tracker.labels]
phase_group = "Agent phase"
runtime_group = "Agent runtime"
runtimes = ["Claude Code", "Codex", "Conductor", "Herdr"]

[github]
repository = ${q(p.repository)}

# Optional features: uncomment the examples you need; \`armada doctor\` lists suggestions.
# Owner alerts and digests are configured on Organization > Notifications, not in TOML.
# Set an HTTPS webhook, language, time zone, quiet hours and digest times/days there; send a test.
# Name coordinator roles with \`armada coordinator use backend\` or ARMADA_COORDINATOR=backend.

# After merges, watch each declared target and pause merges if deploy or smoke fails.
# [[deploy.target]]
# name = "api"
# branch = "main"  # omit to watch any merged base branch
# paths = ["cmd/**", "internal/**"]  # optional: only watch merges touching these globs
# github_environment = "production"
## Alternative to github_environment (choose exactly one live source):
## live_sha_command = 'cd "$DEPLOY_LINK_DIR" && hosting-cli live-sha'
## requires_env = ["DEPLOY_LINK_DIR"]
## On each coordinator machine: armada config set deploy.env.DEPLOY_LINK_DIR /path/to/linked-service
## Machine settings win over the process environment; missing settings skip without a hold.
# smoke = "curl -fsS https://example.test/health"
# timeout_minutes = 20  # 1–120; smoke shares this deadline
# pause_on_failure = true

[git]
sign = "inherit"        # "off" disables commit signing only in new Herdr worktrees, when branch rules allow it

# A root-cause ticket is required for every known flaky failure. Rerun failed jobs once
# with \`armada ci why <pr> --rerun\`; unknown failures are refused.
# [ci]
# failure_patterns = ["FAIL (.+)"]  # optional test-name regex; exactly one capture group
# [[ci.known_failure]]
# check = "test"  # exact check run name
# pattern = "flaky_suite > times out on cold start"  # regex over failing test names or error block
# ticket = "ABC-123"

[gates]
# required_checks = ["test"]  # CI checks that must be green before a hand-back (default: every check)

[merge]
# Queue intent: \`armada merge --when-green <pr...>\`; retest serially with \`armada merge --drain\`.
# queue_retest = "ci" # fresh-main CI before each queued merge; "local" uses gates.local_commands
# Files that concern every working PR, in addition to overlapping files (default: CI workflows).
# notify_paths = [".github/workflows/**", "package.json", "migrations/**"]

[policy]
silence_minutes = 15     # silence since the newest report, heartbeat or answer
launch_grace_minutes = 15 # extra allowance before the first report or heartbeat; defaults to silence_minutes
ci_wait_minutes = 45     # shipping --stage ci has this silence allowance
quiet_minutes = 45       # alive but without a report: a coordinator-only note
coordinator_minutes = 10 # an inbox item open longer than this shows "waiting for the coordinator"
# not_started_minutes = 10 # a launched worker that has not claimed after this long shows as not started
# plans = "approve"       # or "pre-approved": workers post their plan and go on without waiting
# validation_samples = 4  # images per owner question; 1–8
# attachments_per_ticket = 20
# attachments_project_mb = 200
# attachments_retention_days = 30
# pre_approved_label = "plan-approved"      # a ticket with this label skips the approval
# approval_label = "needs-plan-approval"    # a ticket with this label waits for it; wins over the other
# Which merges need your approval, in plain words; without it the coordinator merges everything on its own.
# The coordinator judges it per pull request and sends you one approval link for the others.
# merge_approval = "merge on your own, except front-end changes: send me a link to check them first"

# Kinds of tickets whose work you validate before it goes on: the coordinator judges at launch
# which apply, and the worker shows you its work with \`armada validate\` and waits for your decision.
# [[policy.validation]]
# when = "a design ticket: a mockup, a visual direction or the look of a new screen"
# then = "produce the design, attach it, ask the owner to validate it on Armada, and stop until they decide; never merge or build it on your own"

# Live checks run in the worker checkout at the PR head before hand-back.
# [[acceptance]]
# name = "production build"
# command = "docker build -f deploy/Dockerfile ." # secrets: use "armada run -- ..."
# paths = ["deploy/**", "Dockerfile", "package.json"] # omit for every PR; *, ** and ?
# timeout_minutes = 15                          # positive integer, maximum 120
# max_runs = 3                                  # per check and ticket; coordinator grants more

# Long runs go through \`armada job\` on a runner that survives the terminal.
# Commands run with sh -c here, with ARMADA_JOB_ID, ARMADA_JOB_REF,
# ARMADA_TICKET and ARMADA_PROJECT set. No provider is required.
# [jobs.eval]
# start = "./scripts/start-eval.sh"   # returns within 2 min; last stdout line is the runner reference
# status = "./scripts/job-status.sh" # last line: running|succeeded|failed [progress, e.g. 37/120 cases]
# stop = "./scripts/stop-eval.sh"     # exit 0 means stopped
# silence_minutes = 15              # inbox alarm without news; watch polls at half this interval
# max_hours = 12                     # overdue, never auto-stopped
# Remote runner: set ARMADA_API_KEY as its secret (organization API key), armada login --api-key.
# Push news: armada job beat "$ARMADA_JOB_ID" --progress "40/120" [--state succeeded|failed].
# Declare the shared resources workers reserve through Armada (optional).
# [[reservations]]
# key = "db-migration"
# what = "the next DB_MIGRATIONS version"
# numbered = true

[brief]
# extra = "docs/worker-conventions.md"  # a file every worker brief carries under "Project conventions"

# Launch with \`armada launch <ticket> --runtime conductor\`; the brief carries the sign-in token.
# How \`armada brief\` configures workers on Conductor. Every value is passed explicitly;
# \`conductor model\` lists each agent's model ids and effort levels.
[conductor]
# project_id = "00000000-0000-4000-8000-000000000001"  # optional explicit Conductor project
# base_branch = "main"  # optional; otherwise the repository default
default_profile = "opus"  # used only when no profile has a when rule

[conductor.profiles.opus]
when = "front end: dashboard pages, components, styles, design, UI copy"
agent = "claude"
model = "opus-5-5-1m"
effort = "high"

[conductor.profiles.codex]
when = "back end: CLI, core rules, API, database, migrations, tests, docs"
agent = "codex"
model = "gpt-6.1-sol"
effort = "high"

[conductor.profiles.debug]
when = "a bug to diagnose"
agent = "codex"
model = "gpt-6.1-sol"
effort = "xhigh"

# A worker run as a subagent of a coordinator's Claude Code session, in its own
# worktree (the armada-runtime-claude-code skill). It dies with that session, so
# long runs belong on Conductor. \`model\` is what the Agent tool takes; it applies no effort.
# [conductor.profiles.local]
# runtime = "claude-code"
# agent = "claude"
# model = "opus"
# effort = "high"

# Which profile a ticket gets from its Linear labels: the first rule with a label
# the ticket carries wins, in file order. \`armada brief --profile\` overrides it.
[[conductor.routing]]
labels = ["web"]
profile = "opus"

[[conductor.routing]]
labels = ["api"]
profile = "codex"

[[conductor.routing]]
labels = ["Bug"]
profile = "debug"

# Herdr profiles use one of its supported harnesses and are selected with the
# same label and \`when\` rules as Conductor. Every extra argument is passed to
# the selected harness exactly as written.
# [herdr]
# default_profile = "claude"

# [herdr.profiles.claude]
# harness = "claude"       # "claude", "codex", "opencode" or "deepseek" (OpenCode + DeepSeek model)
# model = "sonnet"
# effort = "high"
# permissions = "ask"      # normal harness approvals; use "full" for the native bypass/auto flag
# extra_args = ["--verbose"]
# when = "a ticket best handled by Claude"

# [[herdr.routing]]
# labels = ["herdr"]
# profile = "claude"
`;
}

/** A project slug from any name: lowercase letters, digits and single dashes. */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}
