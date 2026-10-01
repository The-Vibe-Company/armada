// armada.toml v0: one project = one repository + one tracker program root.
// Secrets never live in this file; tokens come from the environment.
import { parse, TomlError } from "smol-toml";

export const CONFIG_FILE = "armada.toml";

export interface ArmadaConfig {
  project: {
    name: string;
    /** Stable identifier of the project, lowercase letters, digits and dashes. */
    slug: string;
  };
  tracker: {
    /** Identifier of the Linear issue at the root of the program, e.g. ABC-1. */
    programRoot: string;
    /** Language of owner-facing output (BCP 47 tag). Tracker comments stay in English. */
    language: string;
    /** Label that marks a ticket as specified enough for an agent to take. */
    readyLabel: string;
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
    /** A working agent with no report for longer than this shows as silent. */
    silentAfterMinutes: number;
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
  };
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
    /** Profile `armada brief` uses without `--profile`; null when none is declared. */
    defaultProfile: string | null;
    /** Launch settings by profile name, from `[conductor.profiles.<name>]`. */
    profiles: Record<string, ConductorProfile>;
    /** `[[conductor.routing]]` in file order: the first rule matching a ticket's labels picks its profile. */
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

/** A ticket carrying any of `labels` goes to `profile`, unless an earlier rule matched. */
export interface RoutingRule {
  labels: string[];
  profile: string;
}

/** Where a profile's workers run, each with its runtime guide skill (`armada-runtime-<runtime>`). */
export const PROFILE_RUNTIMES = ["conductor", "claude-code"] as const;
export type ProfileRuntime = (typeof PROFILE_RUNTIMES)[number];

/** How a worker is launched: every value is passed explicitly, never left to the runtime's defaults. */
export interface ConductorProfile {
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

export const CONFIG_DEFAULTS = {
  language: "en",
  readyLabel: "ready-for-agent",
  phaseGroup: "Agent phase",
  runtimeGroup: "Agent runtime",
  runtimes: ["Claude Code", "Codex", "Conductor"],
  silentAfterMinutes: 15,
  coordinatorMinutes: 10,
  notStartedMinutes: 10,
  plans: "approve",
  preApprovedLabel: "plan-approved",
  approvalLabel: "needs-plan-approval",
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
  const labelsT = isTable(labels) ? labels : {};
  const policyT = isTable(policy) ? policy : {};
  const gates = raw.gates === undefined ? {} : raw.gates;
  if (!isTable(gates)) problems.push(`"gates" must be a table`);
  const gatesT = isTable(gates) ? gates : {};
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

  // Unknown keys inside known tables are typos; unknown top-level tables are
  // left alone so newer sections do not break older readers.
  const known: [string, Table, string[]][] = [
    ["project", project, ["name", "slug"]],
    ["tracker", tracker, ["program_root", "language", "ready_label", "labels"]],
    ["tracker.labels", labelsT, ["phase_group", "runtime_group", "runtimes"]],
    ["github", github, ["repository"]],
    ["gates", gatesT, ["required_checks", "local_commands"]],
    [
      "policy",
      policyT,
      [
        "silence_minutes",
        "silent_after_minutes",
        "coordinator_minutes",
        "not_started_minutes",
        "plans",
        "pre_approved_label",
        "approval_label",
      ],
    ],
    ["brief", briefT, ["extra"]],
    ["secrets", secretsT, ["names"]],
    ["conductor", conductorT, ["default_profile", "profiles", "routing"]],
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
    known.push([path, p, ["runtime", "agent", "model", "effort", "fast_mode"]]);
    if (p.fast_mode !== undefined && typeof p.fast_mode !== "boolean")
      problems.push(`"${path}.fast_mode" must be true or false`);
    const runtime = p.runtime ?? "conductor";
    if (!PROFILE_RUNTIMES.includes(runtime as ProfileRuntime))
      problems.push(`"${path}.runtime" must be one of ${PROFILE_RUNTIMES.map((r) => `"${r}"`).join(", ")}`);
    if (runtime === "claude-code" && p.agent !== undefined && p.agent !== "claude")
      problems.push(`"${path}.agent" must be "claude" with runtime = "claude-code"`);
    profiles[name] = {
      runtime: PROFILE_RUNTIMES.includes(runtime as ProfileRuntime) ? (runtime as ProfileRuntime) : "conductor",
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
  if (Array.isArray(routingRaw) && routingRaw.length && conductorT.default_profile === undefined)
    problems.push(`"conductor.default_profile" is required with [[conductor.routing]], for tickets no rule matches`);
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
  let coordinatorMinutes: number = CONFIG_DEFAULTS.coordinatorMinutes;
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

  const config: ArmadaConfig = {
    project: {
      name: str(project, "project", "name"),
      slug: str(project, "project", "slug", { pattern: SLUG, hint: "lowercase letters, digits and dashes" }),
    },
    tracker: {
      programRoot: str(tracker, "tracker", "program_root", {
        pattern: ISSUE_ID,
        hint: "an issue identifier such as ABC-1",
      }),
      language: str(tracker, "tracker", "language", { default: CONFIG_DEFAULTS.language }),
      readyLabel: str(tracker, "tracker", "ready_label", { default: CONFIG_DEFAULTS.readyLabel }),
      labels: {
        phaseGroup: str(labelsT, "tracker.labels", "phase_group", { default: CONFIG_DEFAULTS.phaseGroup }),
        runtimeGroup: str(labelsT, "tracker.labels", "runtime_group", { default: CONFIG_DEFAULTS.runtimeGroup }),
        runtimes,
      },
    },
    github: {
      repository: str(github, "github", "repository", { pattern: REPOSITORY, hint: "owner/name" }),
    },
    gates: { requiredChecks, localCommands },
    policy: { silentAfterMinutes, coordinatorMinutes, notStartedMinutes, plans, preApprovedLabel, approvalLabel },
    brief: { extra },
    secrets: { names: secretNames },
    conductor: { defaultProfile, profiles, routing },
  };
  if (problems.length) throw new ConfigError(source, problems);
  config.tracker.programRoot = config.tracker.programRoot.toUpperCase();
  return config;
}

/** A commented armada.toml for a new project; `parseConfig` accepts it as is. */
export function configTemplate(p: { name: string; slug: string; programRoot: string; repository: string }): string {
  const q = JSON.stringify;
  return `# Armada configuration: one project = one repository + one tracker program root.
# No secrets here: keys come from the environment or \`armada auth login\`.

[project]
name = ${q(p.name)}
slug = ${q(p.slug)}          # stable id: lowercase letters, digits and dashes

[tracker]
program_root = ${q(p.programRoot)}  # Linear issue at the root of the program
language = "en"          # language of owner-facing output
ready_label = "ready-for-agent"

[tracker.labels]
phase_group = "Agent phase"
runtime_group = "Agent runtime"
runtimes = ["Claude Code", "Codex", "Conductor"]

[github]
repository = ${q(p.repository)}

[gates]
# required_checks = ["test"]  # CI checks that must be green before a hand-back (default: every check)

[policy]
silence_minutes = 15     # a worker with no report for longer than this shows as silent
coordinator_minutes = 10 # an inbox item open longer than this shows "waiting for the coordinator"
# not_started_minutes = 10 # a launched worker that has not claimed after this long shows as not started
# plans = "approve"       # or "pre-approved": workers post their plan and go on without waiting
# pre_approved_label = "plan-approved"      # a ticket with this label skips the approval
# approval_label = "needs-plan-approval"    # a ticket with this label waits for it; wins over the other

[brief]
# extra = "docs/worker-conventions.md"  # a file every worker brief carries under "Project conventions"

# How \`armada brief\` launches workers on Conductor. Every value is passed explicitly;
# \`conductor model\` lists each agent's model ids and effort levels.
[conductor]
default_profile = "opus"  # for tickets no routing rule matches

[conductor.profiles.opus]
agent = "claude"
model = "opus-5-5-1m"
effort = "high"

[conductor.profiles.codex]
agent = "codex"
model = "gpt-6.1-sol"
effort = "high"

[conductor.profiles.debug]
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
