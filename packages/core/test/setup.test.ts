import { describe, expect, test } from "bun:test";
import {
  BUNDLED_SKILLS,
  type Check,
  checkRepository,
  planSetup,
  type RepoView,
  SetupError,
  type SetupPlan,
  skillFolderHash,
} from "../src/index.ts";
import { DEMO_TOML } from "./support.ts";

const VERSION = "1.2.3";

/** A repository held in memory: files by path, and links by path. */
function memoryRepo(files: Record<string, string> = {}, links: Record<string, string> = {}) {
  const f = new Map(Object.entries(files));
  const l = new Map(Object.entries(links));
  const view: RepoView = {
    readFile: async (p) => f.get(p) ?? null,
    readLink: async (p) => l.get(p) ?? null,
    readFolder: async (dir) => {
      const inside = [...f].filter(([p]) => p.startsWith(`${dir}/`));
      return inside.length
        ? inside.map(([p, c]) => ({ path: p.slice(dir.length + 1), content: new TextEncoder().encode(c) }))
        : null;
    },
  };
  const apply = (plan: SetupPlan) => {
    for (const p of plan.removes) f.delete(p);
    for (const w of plan.writes) f.set(w.path, w.content);
    for (const k of plan.links) l.set(k.path, k.target);
  };
  return { view, files: f, links: l, apply };
}

const levels = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.id, c.level]));
const problems = (checks: Check[]) => checks.filter((c) => c.level !== "ok");

/** A repository set up by Armada: every check passes. */
async function setUpRepo(extra: Record<string, string> = {}) {
  const repo = memoryRepo({ "armada.toml": DEMO_TOML, ...extra });
  repo.apply(await planSetup(repo.view, { armadaVersion: VERSION, configText: null }));
  return repo;
}

describe("repository checks", () => {
  test("an empty repository gets one error per missing piece, each with its fix", async () => {
    const checks = await checkRepository(memoryRepo().view, VERSION);
    const skills = BUNDLED_SKILLS.map((s) => s.name);
    expect(levels(checks)).toEqual({
      config: "error",
      ...Object.fromEntries(skills.map((s) => [`skill:${s}`, "error"])),
      conductor: "error",
      "stop-hook": "warning",
      gitignore: "warning",
    });
    for (const c of problems(checks)) expect(c.fix).toBeTruthy();
    expect(checks.find((c) => c.id === "skill:armada-worker")?.message).toBe(
      "skill armada-worker is missing from .agents/skills",
    );
  });

  test("the plan for an empty repository makes every check pass", async () => {
    const repo = memoryRepo({ "bun.lock": "{}" });
    const plan = await planSetup(repo.view, { armadaVersion: VERSION, configText: DEMO_TOML });
    expect(plan.installed).toEqual(BUNDLED_SKILLS.map((s) => s.name));
    repo.apply(plan);
    expect(problems(await checkRepository(repo.view, VERSION))).toEqual([]);
    expect(repo.files.get(".conductor/settings.toml")).toContain('setup = "bun install --frozen-lockfile"');
    const lock = JSON.parse(repo.files.get("skills-lock.json") ?? "");
    expect(lock.skills["armada-worker"]).toEqual({
      source: "The-Vibe-Company/armada",
      sourceType: "github",
      skillPath: "skills/armada-worker/SKILL.md",
      ref: "v1.2.3",
      computedHash: skillFolderHash(BUNDLED_SKILLS.find((s) => s.name === "armada-worker")?.files ?? []),
    });
    // Nothing left to do: running the plan again changes nothing.
    const again = await planSetup(repo.view, { armadaVersion: VERSION, configText: DEMO_TOML });
    expect(again).toEqual({ writes: [], removes: [], links: [], installed: [], updated: [], stopHook: false });
  });

  test("an outdated skill is a warning, and the plan replaces only that skill and its lock entry", async () => {
    const repo = await setUpRepo();
    repo.files.set(".agents/skills/armada-worker/SKILL.md", "an older worker skill");
    repo.files.set(".agents/skills/armada-worker/OLD.md", "a file the new version dropped");
    const checks = await checkRepository(repo.view, VERSION);
    expect(problems(checks).map((c) => [c.id, c.level, c.message])).toEqual([
      ["skill:armada-worker", "warning", "skill armada-worker differs from the version in Armada 1.2.3"],
      [
        "skill-lock:armada-worker",
        "warning",
        "skills-lock.json records a different content for armada-worker than .agents/skills/armada-worker",
      ],
    ]);
    const plan = await planSetup(repo.view, { armadaVersion: VERSION, configText: null });
    expect(plan.updated).toEqual(["armada-worker"]);
    expect(plan.installed).toEqual([]);
    expect(plan.writes.map((w) => w.path)).toEqual([".agents/skills/armada-worker/SKILL.md"]);
    expect(plan.removes).toEqual([".agents/skills/armada-worker/OLD.md"]);
    repo.apply(plan);
    expect(problems(await checkRepository(repo.view, VERSION))).toEqual([]);
  });

  test("files the repository already has are kept: armada.toml, other lock entries, Conductor scripts, ignores", async () => {
    const otherSkill = { source: "someone/skills", sourceType: "github", computedHash: "abc" };
    const repo = memoryRepo({
      "armada.toml": DEMO_TOML,
      "skills-lock.json": JSON.stringify({ version: 1, skills: { "zz-other": otherSkill } }),
      ".conductor/settings.toml": '[scripts]\nrun = "make dev"\n',
      ".gitignore": "node_modules/\n",
    });
    const plan = await planSetup(repo.view, { armadaVersion: "0.0.0", configText: "should not be written" });
    repo.apply(plan);
    expect(repo.files.get("armada.toml")).toBe(DEMO_TOML);
    const lock = JSON.parse(repo.files.get("skills-lock.json") ?? "");
    expect(Object.keys(lock.skills)).toEqual([...BUNDLED_SKILLS.map((s) => s.name), "zz-other"]);
    expect(lock.skills["zz-other"]).toEqual(otherSkill);
    expect(lock.skills["armada-worker"].ref).toBeUndefined();
    expect(repo.files.get(".conductor/settings.toml")).toBe(
      '[scripts]\n# Commands a fresh workspace runs once: install dependencies, copy env files.\nsetup = "true"\nrun = "make dev"\n',
    );
    expect(repo.files.get(".gitignore")).toBe(
      "node_modules/\n\n# Local agent run artifacts (ship-pr-dev)\nplans/ship-pr-dev/\n",
    );
    expect(problems(await checkRepository(repo.view, VERSION))).toEqual([]);
  });

  test("the stop hook joins the repository's Claude settings, keeps theirs, and is opt-in", async () => {
    const theirs = {
      permissions: { allow: ["Bash(bun test:*)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "make notify" }] }], PreToolUse: [] },
    };
    const repo = memoryRepo({ "armada.toml": DEMO_TOML, ".claude/settings.json": JSON.stringify(theirs) });

    const without = await planSetup(repo.view, { armadaVersion: VERSION, configText: null, stopHook: false });
    expect([without.stopHook, without.writes.some((w) => w.path === ".claude/settings.json")]).toEqual([false, false]);
    repo.apply(without);
    expect(problems(await checkRepository(repo.view, VERSION)).map((c) => [c.id, c.fix])).toEqual([
      [
        "stop-hook",
        "run `armada init` and accept the stop hook (this repository's settings only, never your user settings)",
      ],
    ]);

    const plan = await planSetup(repo.view, { armadaVersion: VERSION, configText: null });
    expect(plan.stopHook).toBe(true);
    expect(plan.writes.map((w) => w.path)).toEqual([".claude/settings.json"]);
    repo.apply(plan);
    expect(JSON.parse(repo.files.get(".claude/settings.json") ?? "")).toEqual({
      ...theirs,
      hooks: {
        ...theirs.hooks,
        Stop: [
          ...theirs.hooks.Stop,
          {
            hooks: [
              {
                type: "command",
                command: "command -v armada >/dev/null 2>&1 || exit 0; armada hook stop",
                timeout: 10,
              },
            ],
          },
        ],
      },
    });
    const checks = await checkRepository(repo.view, VERSION);
    expect(problems(checks)).toEqual([]);
    expect(checks.find((c) => c.id === "stop-hook")?.message).toContain("ARMADA_STOP_HOOK=off turns it off");
    // Installed once: a second run leaves it.
    expect((await planSetup(repo.view, { armadaVersion: VERSION, configText: null })).stopHook).toBe(false);

    repo.files.set(".claude/settings.json", "{ not json");
    expect(problems(await checkRepository(repo.view, VERSION)).map((c) => [c.id, c.message])).toEqual([
      ["stop-hook", "Claude Code stop hook not checked: .claude/settings.json is not valid JSON"],
    ]);
    await expect(planSetup(repo.view, { armadaVersion: VERSION, configText: null })).rejects.toThrow(SetupError);
  });

  test("a routing rule naming an unknown profile is a doctor error", async () => {
    const toml = DEMO_TOML.concat(
      '\n[conductor]\ndefault_profile = "opus"\n[conductor.profiles.opus]\nagent = "claude"\nmodel = "opus-5-5-1m"\neffort = "high"\n',
      '[[conductor.routing]]\nlabels = ["api"]\nprofile = "codex"\n',
    );
    const repo = await setUpRepo({ "armada.toml": toml });
    expect(problems(await checkRepository(repo.view, VERSION))).toEqual([
      {
        id: "config",
        level: "error",
        message:
          'armada.toml is invalid:\n  - "conductor.routing[1].profile" is "codex", but there is no [conductor.profiles.codex]',
        fix: "fix the keys listed above in armada.toml",
      },
    ]);
  });

  test("a .claude/skills that links to .agents/skills as a whole counts as linked", async () => {
    const repo = await setUpRepo();
    for (const s of BUNDLED_SKILLS) repo.links.delete(`.claude/skills/${s.name}`);
    repo.links.set(".claude/skills", "../.agents/skills");
    expect(problems(await checkRepository(repo.view, VERSION))).toEqual([]);
    expect((await planSetup(repo.view, { armadaVersion: VERSION, configText: null })).links).toEqual([]);
  });

  test("a Conductor setup Armada cannot add safely is left to a person", async () => {
    const repo = memoryRepo({ "armada.toml": DEMO_TOML, ".conductor/settings.toml": '[scripts]\nsetup = ""\n' });
    await expect(planSetup(repo.view, { armadaVersion: VERSION, configText: null })).rejects.toThrow(
      ".conductor/settings.toml has a [scripts] table Armada cannot add a setup command to safely",
    );
  });

  test("a broken skills-lock.json is reported and never overwritten", async () => {
    const repo = memoryRepo({ "armada.toml": DEMO_TOML, "skills-lock.json": "{ not json" });
    const checks = await checkRepository(repo.view, VERSION);
    expect(checks.find((c) => c.id === "skills-lock")).toMatchObject({
      level: "error",
      message: "skills-lock.json is not valid JSON",
    });
    await expect(planSetup(repo.view, { armadaVersion: VERSION, configText: null })).rejects.toThrow(SetupError);
  });
});
