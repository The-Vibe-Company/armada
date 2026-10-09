import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import type { BranchRules } from "../src/github.ts";
import { findStopHook, mergeCompatibility, optionalFeatures, signingSetup } from "../src/setup.ts";

const branchRules: BranchRules = {
  defaultBranch: "trunk",
  allowSquashMerge: true,
  deleteBranchOnMerge: false,
  requiredChecks: ["test"],
  requiredApprovals: 0,
  requiredCodeOwnerReview: false,
  requiredLastPushApproval: false,
  mergeQueue: false,
  requiredSignatures: true,
  requiredLinearHistory: true,
  strictChecks: true,
  classicProtection: "read",
};

describe("mergeCompatibility", () => {
  const checks = (rules: Partial<BranchRules> = {}, requiredChecks = ["test"]) =>
    mergeCompatibility({ ...branchRules, ...rules }, { requiredChecks, localCommands: [] });

  test("matching gates, signatures, linear history and up-to-date rules allow squash merges", () => {
    expect(checks()).toHaveLength(5);
    expect(checks().every((c) => c.level === "ok" && c.fix === null)).toBe(true);
    expect(checks({}, []).every((c) => c.level === "ok")).toBe(true);
    expect(checks({ requiredChecks: ["test", "test"] }).every((c) => c.level === "ok")).toBe(true);
  });

  test("one check line names both differences and errors when GitHub can block a hand-back", () => {
    const c = checks({ requiredChecks: ["test", "deploy"] }, ["test", "lint"])[0];
    expect(c?.level).toBe("error");
    expect(c?.message).toContain("deploy");
    expect(c?.message).toContain("lint");
    expect(c?.fix).toContain("required_checks");
    const weaker = checks({ requiredChecks: [] })[0];
    expect(weaker?.level).toBe("warning");
    expect(weaker?.fix).toContain("GitHub");
  });

  test("squash, external approvals and GitHub queue block merges; branch deletion warns", () => {
    const results = checks({
      allowSquashMerge: false,
      requiredApprovals: 2,
      mergeQueue: true,
      deleteBranchOnMerge: true,
    });
    expect(results.map((c) => c.level)).toEqual(["ok", "error", "error", "error", "warning"]);
    expect(results.filter((c) => c.level !== "ok").every((c) => !!c.fix)).toBe(true);
    expect(results[2]?.fix).toContain("reviewer");
    expect(results[4]?.fix).toContain("Automatically delete head branches");
  });

  test("code-owner and last-push review rules block even with a zero approving count", () => {
    for (const rule of [{ requiredCodeOwnerReview: true }, { requiredLastPushApproval: true }]) {
      expect(checks(rule)[2]?.level).toBe("error");
      expect(checks(rule)[2]?.fix).toContain("reviewer");
    }
  });
});

import {
  BUNDLED_SKILLS,
  type Check,
  checkRepository,
  planSetup,
  planSkills,
  type RepoView,
  repositoryOfRemote,
  SetupError,
  type SetupPlan,
  skillFolderHash,
  skillsBehind,
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
  test("Armada pointers retain discovery metadata, migrate old files and ignore instruction-only releases", async () => {
    const repo = await setUpRepo();
    const skill = BUNDLED_SKILLS.find((s) => s.name === "armada-coordinator");
    if (!skill) throw new Error("missing coordinator skill");
    const path = ".agents/skills/armada-coordinator/SKILL.md";
    const pointer = repo.files.get(path) ?? "";
    expect(pointer).toMatch(/^---\nname: armada-coordinator\ndescription: [^\n]+\n---\n/);
    expect(pointer).toContain("description: Coordinating an Armada fleet");
    expect(pointer).toContain("Run `armada skill armada-coordinator` and follow its output");
    expect(pointer).toContain("armada skill armada-coordinator <file>");
    expect(pointer).toContain(
      "https://github.com/The-Vibe-Company/armada/blob/v1.2.3/skills/armada-coordinator/SKILL.md",
    );
    expect(repo.files.has(".agents/skills/armada-coordinator/MERGE.md")).toBe(false);
    for (const bundled of BUNDLED_SKILLS) {
      expect(bundled.delivery).toBe(bundled.name.startsWith("armada-") ? "pointer" : "vendored");
      if (bundled.delivery === "pointer") {
        const content = repo.files.get(`.agents/skills/${bundled.name}/SKILL.md`) ?? "";
        expect(content).toContain(`name: ${bundled.name}`);
        expect(content).toContain(`Run \`armada skill ${bundled.name}\``);
        expect(content).toContain(
          `https://github.com/The-Vibe-Company/armada/blob/v1.2.3/skills/${bundled.name}/SKILL.md`,
        );
      } else {
        for (const file of bundled.files)
          expect(repo.files.get(`.agents/skills/${bundled.name}/${file.path}`)).toBe(file.content);
        const main = repo.files.get(`.agents/skills/${bundled.name}/SKILL.md`) ?? "";
        expect(main).toMatch(/^---\nname: [^\n]+\ndescription: /);
        expect(main).toContain(`name: ${bundled.name}`);
      }
    }
    const main = skill.files.find((f) => f.path === "SKILL.md");
    if (!main) throw new Error("missing instructions");
    const original = main.content;
    try {
      main.content += "\nNew release instructions.\n";
      expect(problems(await checkRepository(repo.view, "1.2.4"))).toEqual([]);
      expect(await skillsBehind(repo.view)).toBeNull();
      expect((await planSkills(repo.view, "1.2.4")).writes).toEqual([]);
      main.content = original.replace("description: Coordinating", "description: Managing");
      expect(levels(await checkRepository(repo.view, "1.2.4"))["skill:armada-coordinator"]).toBe("warning");
      expect((await skillsBehind(repo.view))?.differing).toEqual(["armada-coordinator"]);
      repo.apply(await planSkills(repo.view, "1.2.4"));
      expect(repo.files.get(path)).toContain("/blob/v1.2.4/");
    } finally {
      main.content = original;
    }
    // The one-time conversion removes all old supporting files.
    for (const file of skill.files) repo.files.set(`.agents/skills/${skill.name}/${file.path}`, file.content);
    const migration = await planSkills(repo.view, "1.2.4");
    expect(migration.removes).toContain(".agents/skills/armada-coordinator/MERGE.md");
    repo.apply(migration);
    expect(problems(await checkRepository(repo.view, "1.2.4"))).toEqual([]);
  });

  test("skills update vendors nested dependencies, detects their drift and leaves project settings alone", async () => {
    const repo = memoryRepo({
      ".claude/settings.json": "{ deliberately untouched",
      ".conductor/settings.toml": "custom settings",
    });
    repo.apply(await planSkills(repo.view, VERSION));
    for (const name of ["ship-pr-dev", "review-code-dev", "capture-learning-tools"])
      expect(repo.files.has(`.agents/skills/${name}/companion.json`)).toBe(true);
    const script = ".agents/skills/review-code-dev/scripts/ocr.py";
    expect(repo.files.get(script)).toContain("CHECKSUMS");
    expect(repo.files.get(".agents/skills/review-code-dev/LICENSE")).toContain("Apache License");
    expect(repo.files.get(".agents/skills/ship-pr-dev/LICENSE")).toContain("MIT License");
    repo.files.set(script, "changed nested file");
    expect((await skillsBehind(repo.view))?.differing).toEqual(["review-code-dev"]);
    const repair = await planSkills(repo.view, VERSION);
    expect(repair.updated).toEqual(["review-code-dev"]);
    repo.apply(repair);
    expect(await skillsBehind(repo.view)).toBeNull();
    expect(repo.files.get(".claude/settings.json")).toBe("{ deliberately untouched");
    expect(repo.files.get(".conductor/settings.toml")).toBe("custom settings");
    expect(repo.files.has("armada.toml")).toBe(false);
    expect((await planSkills(repo.view, VERSION)).writes).toEqual([]);
  });
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
      sourceType: "armada-cli",
      skillPath: "skills/armada-worker/SKILL.md",
      ref: "v1.2.3",
      computedHash: skillFolderHash([
        { path: "SKILL.md", content: repo.files.get(".agents/skills/armada-worker/SKILL.md") ?? "" },
      ]),
    });
    // Nothing left to do: running the plan again changes nothing.
    const again = await planSetup(repo.view, { armadaVersion: VERSION, configText: DEMO_TOML });
    expect(again).toEqual({ writes: [], removes: [], links: [], installed: [], updated: [], stopHook: false });
  });

  test("an outdated skill is a warning, and the plan replaces only that skill and its lock entry", async () => {
    const repo = await setUpRepo();
    repo.files.set(".agents/skills/armada-worker/SKILL.md", "an older worker skill");
    repo.files.set(".agents/skills/armada-worker/OLD.md", "a file the new version dropped");
    const lockBefore = repo.files.get("skills-lock.json") ?? "{}";
    const lock = JSON.parse(lockBefore);
    lock.skills["armada-worker"].ref = "v1.1.0";
    lock.skills["ship-pr-dev"].ref = "v1.0.0";
    repo.files.set("skills-lock.json", JSON.stringify(lock));
    const checks = await checkRepository(repo.view, VERSION);
    // The version line names only the skills that differ, and the release the lock records for them.
    const line = "this project's Armada skills are 1.1.0 (armada-worker differs), the CLI is 1.2.3";
    const behind = await skillsBehind(repo.view);
    expect(behind).toEqual({ recorded: "1.1.0", newest: "1.1.0", differing: ["armada-worker"] });
    // Vendored by a newer CLI: this one is to update, not the skills.
    expect((await checkRepository(repo.view, "1.0.0")).find((c) => c.id === "skills-version")).toMatchObject({
      message: "this project's Armada skills are 1.1.0 (armada-worker differs), newer than the CLI 1.0.0",
      fix: "update the CLI, not the skills: npm install -g @the-vibe-company/armada@1.1.0",
    });
    expect(problems(checks).map((c) => [c.id, c.level, c.message])).toEqual([
      ["skill:armada-worker", "warning", "skill armada-worker differs from the version in Armada 1.2.3"],
      [
        "skill-lock:armada-worker",
        "warning",
        "skills-lock.json records a different content for armada-worker than .agents/skills/armada-worker",
      ],
      ["skills-version", "warning", line],
    ]);
    expect(checks.find((c) => c.id === "skills-version")?.fix).toBe(
      "run `armada init` and merge its PR (`armada merge <n> --no-ticket`)",
    );
    repo.files.set("skills-lock.json", lockBefore);
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
                command: "armada hook stop 2>/dev/null || true",
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
    await expect(planSetup(repo.view, { armadaVersion: VERSION, configText: null })).rejects.toThrow(
      ".claude/settings.json is not valid JSON: fix it, or leave the stop hook out with `armada init --no-stop-hook`",
    );
    // Left out, the settings are not read: init goes on.
    expect((await planSetup(repo.view, { armadaVersion: VERSION, configText: null, stopHook: false })).writes).toEqual(
      [],
    );
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

  test("the [brief] extra file is checked: a missing one is a warning", async () => {
    const repo = await setUpRepo({ "armada.toml": `${DEMO_TOML}\n[brief]\nextra = "docs/workers.md"\n` });
    expect(problems(await checkRepository(repo.view, VERSION))).toEqual([
      {
        id: "brief-extra",
        level: "warning",
        message: "[brief] extra names docs/workers.md, which is missing: briefs go out without the project conventions",
        fix: "add docs/workers.md, or fix the path in armada.toml",
      },
    ]);
    repo.files.set("docs/workers.md", "Run make check.\n");
    expect(levels(await checkRepository(repo.view, VERSION))["brief-extra"]).toBe("ok");
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

describe("repositoryOfRemote", () => {
  test("GitHub HTTPS and SSH forms normalize owner/name without credentials", () => {
    for (const remote of [
      "https://github.com/Acme/Widgets.git",
      "https://github.com/acme/widgets",
      "git@github.com:ACME/Widgets.git",
      "ssh://git@github.com/Acme/Widgets.git",
      "ssh://git@github.com:22/acme/widgets",
      "https://user:CANARY@github.com/acme/widgets.git/",
      "  https://GITHUB.COM/acme/widgets.GIT\n",
    ])
      expect(repositoryOfRemote(remote)).toBe("acme/widgets");
    for (const remote of [
      "",
      "/tmp/widgets",
      "../widgets",
      "https://gitlab.com/acme/widgets",
      "git@github.com.evil.test:acme/widgets.git",
      "https://github.com/acme",
      "https://github.com/acme/widgets/extra",
      "https://github.com/acme/widgets?token=CANARY",
      "https://github.com/acme/widgets#fragment",
      "https://github.com/acme/.git",
    ])
      expect(repositoryOfRemote(remote)).toBeNull();
  });
});

describe("signingSetup", () => {
  test("disabled signing ignores unused interactive programs", () => {
    for (const value of [undefined, "false", "0", "no", "off"])
      expect(signingSetup({ "commit.gpgsign": value, "gpg.ssh.program": "/app/op-ssh-sign" })).toMatchObject({
        enabled: false,
        interactive: null,
      });
  });
  test("recognizes Git booleans and only the selected format's signer", () => {
    for (const value of ["true", "1", "yes", "on", ""])
      expect(
        signingSetup({
          "commit.gpgsign": value,
          "gpg.format": "ssh",
          "gpg.ssh.program": '"/Applications/Password Manager.app/op-ssh-sign"',
          "user.signingkey": "CANARY_KEY",
        }),
      ).toMatchObject({ enabled: true, format: "ssh", interactive: "op-ssh-sign", hasKey: true });
    expect(
      signingSetup({ "commit.gpgsign": "true", "gpg.program": "gpg", "gpg.ssh.program": "op-ssh-sign" }),
    ).toMatchObject({ enabled: true, interactive: null, signer: "gpg" });
    expect(signingSetup({ "commit.gpgsign": "true", "gpg.format": "ssh" })).toMatchObject({
      signer: "ssh-keygen",
      interactive: null,
      hasKey: false,
    });
  });
  test("known password-manager signers and GUI pinentry predict a person is needed", () => {
    for (const signer of ["op-ssh-sign", "1password-ssh-sign", "pinentry-mac", "pinentry-qt", "pinentry-gnome3"])
      expect(signingSetup({ "commit.gpgsign": "true", "gpg.program": `/bin/${signer}` }).interactive).toBe(signer);
    expect(signingSetup({ "commit.gpgsign": "true", pinentryProgram: "/bin/pinentry-mac" }).interactive).toBe(
      "pinentry-mac",
    );
    expect(
      signingSetup({ "commit.gpgsign": "true", "gpg.program": "gpg", pinentryProgram: "pinentry-curses" }).interactive,
    ).toBeNull();
    expect(JSON.stringify(signingSetup({ "user.signingkey": "CANARY_KEY" }))).not.toContain("CANARY_KEY");
  });
});

test("signingSetup resolves canonical format programs without warning on unused legacy programs", () => {
  expect(
    signingSetup({ "commit.gpgsign": "true", "gpg.openpgp.program": "/app/pinentry-mac", "gpg.program": "gpg" }),
  ).toMatchObject({ signer: "/app/pinentry-mac", interactive: "pinentry-mac" });
  expect(
    signingSetup({
      "commit.gpgsign": "true",
      "gpg.format": "x509",
      "gpg.x509.program": "gpgsm",
      "gpg.program": "pinentry-mac",
    }),
  ).toMatchObject({ signer: "gpgsm", interactive: null });
  expect(
    signingSetup({ "commit.gpgsign": "true", "gpg.format": "x509", "gpg.x509.program": "/app/pinentry-mac" }),
  ).toMatchObject({ interactive: "pinentry-mac" });
});

test("adapter-resolved OpenPGP alias takes precedence while X.509 ignores it", () => {
  expect(
    signingSetup({ "commit.gpgsign": "true", "gpg.openpgp.program": "pinentry-mac", openpgpProgram: "gpg" }),
  ).toMatchObject({ signer: "gpg", interactive: null });
  expect(
    signingSetup({
      "commit.gpgsign": "true",
      "gpg.format": "x509",
      "gpg.x509.program": "gpgsm",
      openpgpProgram: "pinentry-mac",
    }),
  ).toMatchObject({ signer: "gpgsm", interactive: null });
});

// Owner: adoption hints stay informational, and disappear when the feature is configured.
test("optional feature discovery guides old configs without making optional setup a failure", () => {
  const baseline = parseConfig(DEMO_TOML);
  const hints = optionalFeatures(baseline);
  expect(hints.map((c) => c.id)).toEqual([
    "optional:deploy",
    "optional:flakes",
    "optional:acceptance",
    "optional:jobs",
    "optional:policy",
    "optional:merge",
    "optional:notifications",
    "optional:coordinators",
  ]);
  expect(hints.every((c) => c.level === "info" && c.fix === null && !c.message.includes("\n"))).toBe(true);
  for (const [toml, gone] of [
    ['[[deploy.target]]\nname = "api"\ngithub_environment = "production"', "optional:deploy"],
    ['[[ci.known_failure]]\ncheck = "test"\npattern = "cold start"\nticket = "DEMO-12"', "optional:flakes"],
    ['[[acceptance]]\nname = "build"\ncommand = "npm run build"', "optional:acceptance"],
    ['[jobs.build]\nstart = "dispatch"\nstop = "cancel"', "optional:jobs"],
    ['[policy]\nmerge_approval = "ask for owner approval"', "optional:policy"],
    ['[[policy.validation]]\nwhen = "design"\nthen = "show a mockup"', "optional:policy"],
    ['[merge]\nnotify_paths = ["package.json"]', "optional:merge"],
    ["[merge]\nnotify_paths = []", "optional:merge"],
  ]) {
    const configured = optionalFeatures(parseConfig(`${DEMO_TOML}\n${toml}`));
    expect(configured.map((c) => c.id)).toEqual(hints.filter((c) => c.id !== gone).map((c) => c.id));
  }
  // Server and machine settings cannot be inferred from TOML; pointers never say they are absent.
  expect(hints.find((c) => c.id === "optional:notifications")?.message).toContain("Organization > Notifications");
  expect(hints.find((c) => c.id === "optional:coordinators")?.message).toContain("armada coordinator use");
});

test("hook detection reads user, project and local settings without modifying them", async () => {
  const files = [
    "/home/coordinator/.claude/settings.json",
    "/work/widgets/.claude/settings.json",
    "/work/widgets/.claude/settings.local.json",
  ] as const;
  const hook = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "armada hook stop" }] }] } });
  for (const file of files) {
    const contents = new Map<string, string>(files.map((path) => [path, path === file ? hook : "{}"]));
    expect(await findStopHook(async (path) => contents.get(path) ?? null, files)).toBe(file);
  }
  expect(
    await findStopHook(async (path) => (path === files[0] ? "not json" : path === files[2] ? hook : null), files),
  ).toBe(files[2]);
  expect(
    await findStopHook(async () => {
      throw new Error("unreadable");
    }, files),
  ).toBeNull();
});
