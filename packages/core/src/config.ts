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
    };
  };
  github: {
    /** owner/name */
    repository: string;
  };
  policy: {
    /** A working agent with no update for longer than this shows as silent. */
    silentAfterMinutes: number;
  };
}

export const CONFIG_DEFAULTS = {
  language: "en",
  readyLabel: "ready-for-agent",
  phaseGroup: "Agent phase",
  runtimeGroup: "Agent runtime",
  silentAfterMinutes: 15,
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

  // Unknown keys inside known tables are typos; unknown top-level tables are
  // left alone so newer sections do not break older readers.
  const known: [string, Table, string[]][] = [
    ["project", project, ["name", "slug"]],
    ["tracker", tracker, ["program_root", "language", "ready_label", "labels"]],
    ["tracker.labels", labelsT, ["phase_group", "runtime_group"]],
    ["github", github, ["repository"]],
    ["policy", policyT, ["silent_after_minutes"]],
  ];
  for (const [path, t, keys] of known)
    for (const key of Object.keys(t)) if (!keys.includes(key)) problems.push(`unknown key "${path}.${key}"`);

  let silentAfterMinutes: number = CONFIG_DEFAULTS.silentAfterMinutes;
  if (policyT.silent_after_minutes !== undefined) {
    const v = policyT.silent_after_minutes;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) silentAfterMinutes = v;
    else problems.push(`"policy.silent_after_minutes" must be a positive number`);
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
      },
    },
    github: {
      repository: str(github, "github", "repository", { pattern: REPOSITORY, hint: "owner/name" }),
    },
    policy: { silentAfterMinutes },
  };
  if (problems.length) throw new ConfigError(source, problems);
  config.tracker.programRoot = config.tracker.programRoot.toUpperCase();
  return config;
}
