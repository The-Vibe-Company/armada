// What a repository needs to be run by Armada, checked by `armada doctor` and
// installed by `armada init`. Everything here reads the repository through a
// RepoView, so the same rules run on a working tree or on a fresh checkout of
// the default branch, and tests need no git.
import { parse, TomlError } from "smol-toml";
import { compareVersions, installCommand } from "./armada-api.ts";
import { CONFIG_FILE, ConfigError, parseConfig } from "./config.ts";
import { BUNDLED_SKILLS, type BundledSkill, SKILLS_SOURCE, skillFolderHash } from "./skills.ts";

export const AGENTS_SKILLS_DIR = ".agents/skills";
export const CLAUDE_SKILLS_DIR = ".claude/skills";
export const SKILLS_LOCK_FILE = "skills-lock.json";
export const CONDUCTOR_SETTINGS = ".conductor/settings.toml";
/** Claude Code's project settings, shared by every session in the repository. */
export const CLAUDE_SETTINGS = ".claude/settings.json";
/**
 * The Claude Code stop hook: a coordinator cannot end its turn while workers
 * are in flight and no `armada watch` runs. It blocks only through the JSON it
 * prints; any failure (no global `armada`, an older one without `hook`) exits
 * 0, since Claude Code would read an exit code of 2 as a block.
 */
export const STOP_HOOK_COMMAND = "armada hook stop 2>/dev/null || true";
export const GITIGNORE = ".gitignore";
/** ship-pr-dev writes its run artifacts here and refuses to start unless git ignores them. */
export const SHIP_ARTIFACTS = "plans/ship-pr-dev/";

/** Read-only access to one checkout of a repository. Paths are `/`-separated and relative to its root. */
export interface RepoView {
  /** Text of a file, or null when it does not exist. */
  readFile(path: string): Promise<string | null>;
  /** Target of a symbolic link, or null when the path is not a link. */
  readLink(path: string): Promise<string | null>;
  /** Every file under a directory with its raw content, or null when the directory does not exist. */
  readFolder(path: string): Promise<{ path: string; content: Uint8Array }[] | null>;
}

export type CheckLevel = "ok" | "warning" | "error";

export interface Check {
  /** Stable identifier, e.g. `skill:armada-worker`. */
  id: string;
  level: CheckLevel;
  /** What was checked, or what is wrong when level is not ok. */
  message: string;
  /** How to fix it; null when level is ok. */
  fix: string | null;
}

const ok = (id: string, message: string): Check => ({ id, level: "ok", message, fix: null });
const bad = (id: string, level: Exclude<CheckLevel, "ok">, message: string, fix: string): Check => ({
  id,
  level,
  message,
  fix,
});

const skillDir = (name: string) => `${AGENTS_SKILLS_DIR}/${name}`;
const linkPath = (name: string) => `${CLAUDE_SKILLS_DIR}/${name}`;
/** The link `npx skills` creates: relative, so it survives a clone anywhere. */
export const skillLinkTarget = (name: string) => `../../${AGENTS_SKILLS_DIR}/${name}`;
const bundledHash = (s: BundledSkill) => skillFolderHash(s.files);
/** `.claude/skills` may itself link to `.agents/skills`; every skill is then visible through it. */
const WHOLE_DIR_LINKS = new Set(["../.agents/skills", "../.agents/skills/"]);
const linksWholeDir = async (view: RepoView) => WHOLE_DIR_LINKS.has((await view.readLink(CLAUDE_SKILLS_DIR)) ?? "");

export interface LockEntry {
  source: string;
  sourceType: string;
  skillPath?: string;
  ref?: string;
  computedHash: string;
  [key: string]: unknown;
}

export interface SkillsLock {
  version: number;
  skills: Record<string, LockEntry>;
}

export class SetupError extends Error {
  override name = "SetupError";
}

/** Parses skills-lock.json; null when absent. Throws SetupError when it is not the `npx skills` format. */
export function parseSkillsLock(text: string | null): SkillsLock | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SetupError(`${SKILLS_LOCK_FILE} is not valid JSON`);
  }
  const lock = raw as Partial<SkillsLock>;
  if (typeof lock?.version !== "number" || typeof lock.skills !== "object" || lock.skills === null)
    throw new SetupError(`${SKILLS_LOCK_FILE} has no "version" number and "skills" object`);
  return lock as SkillsLock;
}

/** The value of `[scripts] setup`, "" when absent. Throws SetupError when the file is not TOML. */
function conductorSetup(text: string): string {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (err) {
    const where = err instanceof TomlError ? ` (line ${err.line}, column ${err.column})` : "";
    throw new SetupError(`${CONDUCTOR_SETTINGS} is not valid TOML${where}`);
  }
  const scripts = raw.scripts as Record<string, unknown> | undefined;
  const setup = scripts?.setup;
  return typeof setup === "string" ? setup.trim() : "";
}

const IGNORES_SHIP = new Set(["plans/ship-pr-dev/", "plans/ship-pr-dev", "plans/", "plans", "plans/*"]);
export const ignoresShipArtifacts = (gitignore: string | null) =>
  (gitignore ?? "").split(/\r?\n/).some((l) => IGNORES_SHIP.has(l.trim().replace(/^\//, "")));

/** The hash of a vendored skill's folder; null when it is not installed. */
async function installedHash(view: RepoView, name: string): Promise<string | null> {
  const folder = await view.readFolder(skillDir(name));
  return folder?.some((f) => f.path === "SKILL.md") ? skillFolderHash(folder) : null;
}

/**
 * The project's Armada skills that differ from this CLI's copy, and the
 * oldest and newest releases `skills-lock.json` records for them (null when it
 * records none). A recorded release older than the CLI alone is not "behind":
 * Armada releases several times a day, mostly without a skill change.
 */
export interface SkillsBehind {
  recorded: string | null;
  newest: string | null;
  differing: string[];
}

function behindOf(lock: SkillsLock | null, differing: string[]): SkillsBehind | null {
  if (!differing.length) return null;
  const refs = differing
    .flatMap((name) => {
      const ref = lock?.skills[name]?.ref;
      return typeof ref === "string" && /^v\d/.test(ref) ? [ref.slice(1)] : [];
    })
    .sort(compareVersions);
  return { recorded: refs[0] ?? null, newest: refs.at(-1) ?? null, differing };
}

/** Skills a newer CLI vendored: this CLI would take them back, so it is the one to update. */
const ahead = (b: SkillsBehind, cli: string) => (b.newest && compareVersions(b.newest, cli) > 0 ? b.newest : null);

function skillsBehindMessage(b: SkillsBehind, cli: string): string {
  const which = `${b.differing.join(", ")} ${b.differing.length === 1 ? "differs" : "differ"}`;
  const newer = ahead(b, cli);
  if (newer) return `this project's Armada skills are ${newer} (${which}), newer than the CLI ${cli}`;
  return `this project's Armada skills are ${b.recorded ?? "of an unrecorded version"} (${which}), the CLI is ${cli}`;
}

function skillsBehindFix(b: SkillsBehind, cli: string): string {
  const newer = ahead(b, cli);
  return newer
    ? `update the CLI, not the skills: ${installCommand(newer)}`
    : "run `armada init` and merge its PR (`armada merge <n> --no-ticket`)";
}

/** The one line naming skills that differ from the CLI's, with what to do; for `armada status`. */
export const skillsBehindLine = (b: SkillsBehind, cli: string) =>
  `${skillsBehindMessage(b, cli)}: ${skillsBehindFix(b, cli)}`;

/**
 * Whether the project's vendored Armada skills differ from this CLI's copy;
 * null when they match, or are not installed (`armada doctor` says that), or
 * the lock cannot be read.
 */
export async function skillsBehind(view: RepoView): Promise<SkillsBehind | null> {
  let lock: SkillsLock | null;
  try {
    lock = parseSkillsLock(await view.readFile(SKILLS_LOCK_FILE));
  } catch (err) {
    if (err instanceof SetupError) lock = null;
    else throw err;
  }
  const differing: string[] = [];
  for (const skill of BUNDLED_SKILLS) {
    const installed = await installedHash(view, skill.name);
    if (installed !== null && installed !== bundledHash(skill)) differing.push(skill.name);
  }
  return behindOf(lock, differing);
}

/** Checks everything in the repository itself; the tracker labels are checked by checkLabels. */
export async function checkRepository(view: RepoView, armadaVersion: string): Promise<Check[]> {
  const checks: Check[] = [];

  const configText = await view.readFile(CONFIG_FILE);
  if (configText === null)
    checks.push(
      bad(
        "config",
        "error",
        `${CONFIG_FILE} is missing`,
        "run `armada init --program-root <ISSUE-ID>` to open a pull request that adds it",
      ),
    );
  else
    try {
      const config = parseConfig(configText, CONFIG_FILE);
      checks.push(ok("config", `${CONFIG_FILE} is valid (project ${config.project.slug})`));
      const extra = config.brief.extra;
      if (extra)
        checks.push(
          (await view.readFile(extra)) === null
            ? bad(
                "brief-extra",
                "warning",
                `[brief] extra names ${extra}, which is missing: briefs go out without the project conventions`,
                `add ${extra}, or fix the path in ${CONFIG_FILE}`,
              )
            : ok("brief-extra", `${extra} goes into every brief as the project conventions`),
        );
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      checks.push(bad("config", "error", err.message, `fix the keys listed above in ${CONFIG_FILE}`));
    }

  let lock: SkillsLock | null = null;
  let lockError: string | null = null;
  try {
    lock = parseSkillsLock(await view.readFile(SKILLS_LOCK_FILE));
  } catch (err) {
    if (!(err instanceof SetupError)) throw err;
    lockError = err.message;
  }
  if (lockError) checks.push(bad("skills-lock", "error", lockError, `repair or delete ${SKILLS_LOCK_FILE}`));

  const wholeDir = await linksWholeDir(view);
  const differing: string[] = [];
  let present = 0;
  for (const skill of BUNDLED_SKILLS) {
    const installed = await installedHash(view, skill.name);
    const id = `skill:${skill.name}`;
    if (installed === null) {
      // Its link and lock entry come with the install; one line per missing skill is enough.
      checks.push(bad(id, "error", `skill ${skill.name} is missing from ${AGENTS_SKILLS_DIR}`, "run `armada init`"));
      continue;
    }
    present++;
    if (installed !== bundledHash(skill)) {
      differing.push(skill.name);
      checks.push(
        bad(
          id,
          "warning",
          `skill ${skill.name} differs from the version in Armada ${armadaVersion}`,
          "run `armada init` to open a pull request that updates it",
        ),
      );
    } else checks.push(ok(id, `skill ${skill.name} is up to date`));

    const target = await view.readLink(linkPath(skill.name));
    const linkId = `skill-link:${skill.name}`;
    if (wholeDir) checks.push(ok(linkId, `${CLAUDE_SKILLS_DIR} links to ${AGENTS_SKILLS_DIR}`));
    else if (target === skillLinkTarget(skill.name))
      checks.push(ok(linkId, `${linkPath(skill.name)} links to ${skillDir(skill.name)}`));
    else
      checks.push(
        bad(
          linkId,
          "error",
          target === null
            ? `${linkPath(skill.name)} is not a link to ${skillDir(skill.name)}, so Claude Code does not see the skill`
            : `${linkPath(skill.name)} links to ${target} instead of ${skillLinkTarget(skill.name)}`,
          "run `armada init`",
        ),
      );

    if (lockError) continue;
    const entry = lock?.skills[skill.name];
    const lockId = `skill-lock:${skill.name}`;
    if (!entry)
      checks.push(bad(lockId, "error", `${SKILLS_LOCK_FILE} does not record ${skill.name}`, "run `armada init`"));
    else if (installed !== null && entry.computedHash !== installed)
      checks.push(
        bad(
          lockId,
          "warning",
          `${SKILLS_LOCK_FILE} records a different content for ${skill.name} than ${skillDir(skill.name)}`,
          "run `armada init`",
        ),
      );
    else checks.push(ok(lockId, `${SKILLS_LOCK_FILE} records ${skill.name}`));
  }
  const behind = behindOf(lock, differing);
  if (behind)
    checks.push(
      bad(
        "skills-version",
        "warning",
        skillsBehindMessage(behind, armadaVersion),
        skillsBehindFix(behind, armadaVersion),
      ),
    );
  else if (present) checks.push(ok("skills-version", `this project's Armada skills match Armada ${armadaVersion}'s`));

  const settings = await view.readFile(CONDUCTOR_SETTINGS);
  if (settings === null)
    checks.push(
      bad("conductor", "error", `${CONDUCTOR_SETTINGS} is missing`, "run `armada init` to add it with a setup script"),
    );
  else
    try {
      checks.push(
        conductorSetup(settings)
          ? ok("conductor", `${CONDUCTOR_SETTINGS} has a setup script`)
          : bad(
              "conductor",
              "error",
              `${CONDUCTOR_SETTINGS} has no [scripts] setup`,
              "run `armada init`, or add a setup command under [scripts]",
            ),
      );
    } catch (err) {
      if (!(err instanceof SetupError)) throw err;
      checks.push(bad("conductor", "error", err.message, `fix ${CONDUCTOR_SETTINGS}`));
    }

  checks.push(await stopHookCheck(view));

  checks.push(
    ignoresShipArtifacts(await view.readFile(GITIGNORE))
      ? ok("gitignore", `${GITIGNORE} ignores ${SHIP_ARTIFACTS}`)
      : bad(
          "gitignore",
          "warning",
          `${GITIGNORE} does not ignore ${SHIP_ARTIFACTS}, so the ship-pr-dev skill refuses to start`,
          "run `armada init`",
        ),
  );
  return checks;
}

// ------------------------------------------------------------------ the Claude Code stop hook

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Claude Code's settings as an object; null when absent. Throws SetupError when it is not a JSON object. */
function claudeSettings(text: string | null): Json | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SetupError(`${CLAUDE_SETTINGS} is not valid JSON`);
  }
  if (!isObject(raw)) throw new SetupError(`${CLAUDE_SETTINGS} is not a JSON object`);
  return raw;
}

/** True when the settings run `armada hook stop` on Stop, in any form. */
export function hasStopHook(settings: Json | null): boolean {
  const stop = isObject(settings?.hooks) ? (settings.hooks as Json).Stop : undefined;
  if (!Array.isArray(stop)) return false;
  return stop.some(
    (group) =>
      isObject(group) &&
      Array.isArray(group.hooks) &&
      group.hooks.some((h) => isObject(h) && typeof h.command === "string" && h.command.includes("armada hook stop")),
  );
}

/** The settings text with Armada's stop hook added next to any other hook. Throws SetupError on a layout it cannot extend. */
export function withStopHook(text: string | null): string {
  const settings = claudeSettings(text) ?? {};
  if (hasStopHook(settings)) return text ?? "";
  const hooks = settings.hooks ?? {};
  if (!isObject(hooks)) throw new SetupError(`${CLAUDE_SETTINGS} has a "hooks" value that is not an object`);
  const stop = hooks.Stop ?? [];
  if (!Array.isArray(stop)) throw new SetupError(`${CLAUDE_SETTINGS} has a "hooks.Stop" value that is not a list`);
  const entry = { hooks: [{ type: "command", command: STOP_HOOK_COMMAND, timeout: 10 }] };
  return `${JSON.stringify({ ...settings, hooks: { ...hooks, Stop: [...stop, entry] } }, null, 2)}\n`;
}

async function stopHookCheck(view: RepoView): Promise<Check> {
  const id = "stop-hook";
  let settings: Json | null;
  try {
    settings = claudeSettings(await view.readFile(CLAUDE_SETTINGS));
  } catch (err) {
    if (!(err instanceof SetupError)) throw err;
    return bad(id, "warning", `Claude Code stop hook not checked: ${err.message}`, `fix ${CLAUDE_SETTINGS}`);
  }
  return hasStopHook(settings)
    ? ok(
        id,
        `${CLAUDE_SETTINGS} has Armada's stop hook: a Claude Code coordinator cannot end its turn while workers are in flight and no armada watch runs (ARMADA_STOP_HOOK=off turns it off)`,
      )
    : bad(
        id,
        "warning",
        `${CLAUDE_SETTINGS} has no Armada stop hook, so a Claude Code coordinator can stop watching its fleet without noticing`,
        "run `armada init` and accept the stop hook (this repository's settings only, never your user settings)",
      );
}

// ------------------------------------------------------------------ plan

export interface SetupPlan {
  /** Files to create or replace, with their full content. */
  writes: { path: string; content: string }[];
  /** Files to delete: leftovers of an older skill version. */
  removes: string[];
  /** Symbolic links to create, replacing whatever is at the path. */
  links: { path: string; target: string }[];
  /** Skills added by this plan, and skills replaced by a newer version. */
  installed: string[];
  updated: string[];
  /** The plan adds the Claude Code stop hook to the repository's Claude settings. */
  stopHook: boolean;
}

export interface PlanOptions {
  armadaVersion: string;
  /** armada.toml to add when the repository has none; null keeps it absent. */
  configText: string | null;
  /** Add the Claude Code stop hook to the repository's Claude settings (default true). */
  stopHook?: boolean;
}

/** Command a fresh Conductor workspace runs, guessed from the lockfile. */
export async function guessSetupCommand(view: RepoView): Promise<string | null> {
  const has = async (p: string) => (await view.readFile(p)) !== null;
  if ((await has("bun.lock")) || (await has("bun.lockb"))) return "bun install --frozen-lockfile";
  if (await has("pnpm-lock.yaml")) return "pnpm install --frozen-lockfile";
  if (await has("yarn.lock")) return "yarn install --frozen-lockfile";
  if (await has("package-lock.json")) return "npm ci";
  return null;
}

const SETUP_COMMENT = "# Commands a fresh workspace runs once: install dependencies, copy env files.";

function conductorSettings(setup: string | null): string {
  return `"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

[scripts]
${SETUP_COMMENT}
setup = ${JSON.stringify(setup ?? "true")}
`;
}

/**
 * Adds `setup` under an existing [scripts] table, or appends the table. The
 * result must parse and carry the new command; any other layout (an empty
 * setup key, an inline or dotted scripts table) is left for a person to edit.
 */
function withSetup(text: string, setup: string | null): string {
  const command = setup ?? "true";
  const line = `${SETUP_COMMENT}\nsetup = ${JSON.stringify(command)}`;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^\s*\[scripts\]\s*(#.*)?$/.test(l));
  let edited: string;
  if (at >= 0) {
    lines.splice(at + 1, 0, line);
    edited = lines.join("\n");
  } else edited = `${text.replace(/\n*$/, "\n")}\n[scripts]\n${line}\n`;
  let result = "";
  try {
    result = conductorSetup(edited);
  } catch {}
  if (result !== command)
    throw new SetupError(
      `${CONDUCTOR_SETTINGS} has a [scripts] table Armada cannot add a setup command to safely; set \`setup\` under [scripts] by hand`,
    );
  return edited;
}

/** skills-lock.json text with Armada's entries set, keys sorted like `npx skills` writes them. */
export function lockText(lock: SkillsLock | null, armadaVersion: string): string {
  const skills: Record<string, LockEntry> = { ...(lock?.skills ?? {}) };
  for (const s of BUNDLED_SKILLS)
    skills[s.name] = {
      source: SKILLS_SOURCE,
      sourceType: "github",
      skillPath: `skills/${s.name}/SKILL.md`,
      // A development build has no release tag to restore from.
      ...(armadaVersion === "0.0.0" ? {} : { ref: `v${armadaVersion}` }),
      computedHash: bundledHash(s),
    };
  const sorted = Object.fromEntries(
    Object.keys(skills)
      .sort()
      .map((k) => [k, skills[k]]),
  );
  return `${JSON.stringify({ version: lock?.version ?? 1, skills: sorted }, null, 2)}\n`;
}

/** Update only bundled skills, their links/lock and the shipping artifact ignore. */
export async function planSkills(view: RepoView, armadaVersion: string): Promise<SetupPlan> {
  const plan: SetupPlan = { writes: [], removes: [], links: [], installed: [], updated: [], stopHook: false };
  const wholeDir = await linksWholeDir(view);
  for (const skill of BUNDLED_SKILLS) {
    const folder = await view.readFolder(skillDir(skill.name));
    const current = folder?.length ? skillFolderHash(folder) === bundledHash(skill) : false;
    if (!current) {
      (folder?.length ? plan.updated : plan.installed).push(skill.name);
      for (const f of skill.files) plan.writes.push({ path: `${skillDir(skill.name)}/${f.path}`, content: f.content });
      const keep = new Set(skill.files.map((f) => f.path));
      for (const f of folder ?? []) if (!keep.has(f.path)) plan.removes.push(`${skillDir(skill.name)}/${f.path}`);
    }
    if (!wholeDir && (await view.readLink(linkPath(skill.name))) !== skillLinkTarget(skill.name))
      plan.links.push({ path: linkPath(skill.name), target: skillLinkTarget(skill.name) });
  }

  const lockBefore = await view.readFile(SKILLS_LOCK_FILE);
  const lockAfter = lockText(parseSkillsLock(lockBefore), armadaVersion);
  if (lockAfter !== lockBefore) plan.writes.push({ path: SKILLS_LOCK_FILE, content: lockAfter });

  const gitignore = await view.readFile(GITIGNORE);
  if (!ignoresShipArtifacts(gitignore)) {
    const base = gitignore === null || gitignore === "" ? "" : `${gitignore.replace(/\n*$/, "\n")}\n`;
    plan.writes.push({
      path: GITIGNORE,
      content: `${base}# Local agent run artifacts (ship-pr-dev)\n${SHIP_ARTIFACTS}\n`,
    });
  }
  return plan;
}

/**
 * The smallest set of changes that makes checkRepository pass: missing or
 * outdated skills, links, lock entries, Conductor setup and the ignore line.
 * Never replaces an existing armada.toml. Throws SetupError when a file it
 * must edit cannot be read safely.
 */
export async function planSetup(view: RepoView, opts: PlanOptions): Promise<SetupPlan> {
  const plan = await planSkills(view, opts.armadaVersion);

  if (opts.configText !== null && (await view.readFile(CONFIG_FILE)) === null)
    plan.writes.push({ path: CONFIG_FILE, content: opts.configText });

  const settings = await view.readFile(CONDUCTOR_SETTINGS);
  if (settings === null)
    plan.writes.push({ path: CONDUCTOR_SETTINGS, content: conductorSettings(await guessSetupCommand(view)) });
  else if (!conductorSetup(settings))
    plan.writes.push({ path: CONDUCTOR_SETTINGS, content: withSetup(settings, await guessSetupCommand(view)) });

  if (opts.stopHook ?? true) {
    const before = await view.readFile(CLAUDE_SETTINGS);
    let after: string;
    try {
      after = withStopHook(before);
    } catch (err) {
      if (!(err instanceof SetupError)) throw err;
      throw new SetupError(`${err.message}: fix it, or leave the stop hook out with \`armada init --no-stop-hook\``);
    }
    if (after !== (before ?? "")) {
      plan.writes.push({ path: CLAUDE_SETTINGS, content: after });
      plan.stopHook = true;
    }
  }

  return plan;
}

export const planIsEmpty = (p: SetupPlan) => !p.writes.length && !p.removes.length && !p.links.length;
