import { describe, expect, test } from "bun:test";
import { ConfigError, configTemplate, parseConfig } from "../src/config.ts";
import { DEMO_TOML } from "./support.ts";

const problemsOf = (text: string) => {
  try {
    parseConfig(text);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error("expected a ConfigError");
};

describe("armada.toml", () => {
  test("a minimal file gets the protocol defaults", () => {
    expect(parseConfig(DEMO_TOML)).toEqual({
      project: { name: "Widgets", slug: "widgets" },
      tracker: {
        programRoot: "DEMO-1",
        language: "en",
        readyLabel: "ready-for-agent",
        labels: {
          phaseGroup: "Agent phase",
          runtimeGroup: "Agent runtime",
          runtimes: ["Claude Code", "Codex", "Conductor"],
        },
      },
      github: { repository: "acme/widgets" },
      gates: { requiredChecks: [], localCommands: [] },
      policy: {
        silentAfterMinutes: 15,
        coordinatorMinutes: 10,
        notStartedMinutes: 10,
        plans: "approve",
        preApprovedLabel: "plan-approved",
        approvalLabel: "needs-plan-approval",
      },
      brief: { extra: null },
      secrets: { names: [] },
      conductor: { defaultProfile: null, profiles: {}, routing: [] },
    });
  });

  test("every missing key is named at once", () => {
    expect(problemsOf(`[project]\nname = "Widgets"\n[tracker]\nlanguage = "fr"\n`)).toEqual([
      "missing required table [github]",
      'missing required key "project.slug"',
      'missing required key "tracker.program_root"',
      'missing required key "github.repository"',
    ]);
  });

  test("invalid values name the key and the expected shape", () => {
    const text = DEMO_TOML.replace('slug = "widgets"', 'slug = "My Widgets"')
      .replace('repository = "acme/widgets"', 'repository = "widgets"')
      .replace('program_root = "DEMO-1"', 'program_root = "DEMO-1"\n[tracker.labels]\nruntimes = []')
      .concat(
        '\n[policy]\nsilence_minutes = -1\nnot_started_minutes = "ten"\n[gates]\nrequired_checks = 1\nlocal_commands = [""]\n',
      );
    expect(problemsOf(text)).toEqual([
      '"tracker.labels.runtimes" must be a non-empty list of names',
      '"policy.silence_minutes" must be a positive number',
      '"policy.not_started_minutes" must be a positive number',
      '"gates.required_checks" must be a list of check names',
      '"gates.local_commands" must be a list of shell commands',
      '"project.slug" is "My Widgets", expected lowercase letters, digits and dashes',
      '"github.repository" is "widgets", expected owner/name',
    ]);
  });

  test("a misspelled key in a known table is reported; unknown tables are left for newer readers", () => {
    const text = DEMO_TOML.replace('program_root = "DEMO-1"', 'program_root = "DEMO-1"\nredy_label = "go"').concat(
      '\n[deploys]\nprofile = "x"\n',
    );
    expect(problemsOf(text)).toEqual(['unknown key "tracker.redy_label"']);
  });

  test("the secrets a project's workers expect: names only, upper snake case", () => {
    const named = parseConfig(
      `${DEMO_TOML}\n[secrets]\nnames = ["OPENAI_API_KEY", " TEST_DATABASE_URL ", "OPENAI_API_KEY"]\n`,
    );
    expect(named.secrets.names).toEqual(["OPENAI_API_KEY", "TEST_DATABASE_URL"]);
    expect(problemsOf(`${DEMO_TOML}\n[secrets]\nnames = ["GITHUB_TOKEN"]\n`)).toHaveLength(1);
    expect(problemsOf(`${DEMO_TOML}\n[secrets]\nnames = ["openai_api_key"]\nvalues = 1\n`)).toEqual([
      'unknown key "secrets.values"',
      '"secrets.names" must be a list of secret names in upper snake case, e.g. ["OPENAI_API_KEY"], none of Armada\'s own keys',
    ]);
  });

  test("the plan policy, its two labels and the brief's conventions file", () => {
    const text = DEMO_TOML.concat(
      '\n[policy]\nplans = "pre-approved"\npre_approved_label = "Go"\napproval_label = "Review plan"\n[brief]\nextra = "docs/workers.md"\n',
    );
    const config = parseConfig(text);
    expect(config.policy).toMatchObject({
      plans: "pre-approved",
      preApprovedLabel: "Go",
      approvalLabel: "Review plan",
    });
    expect(config.brief).toEqual({ extra: "docs/workers.md" });
    expect(
      problemsOf(
        DEMO_TOML.concat(
          '\n[policy]\nplans = "yes"\npre_approved_label = "Plan OK"\napproval_label = "plan-ok"\n[brief]\nextra = "../notes.md"\n',
        ),
      ),
    ).toEqual([
      '"policy.plans" must be "approve" or "pre-approved"',
      '"policy.pre_approved_label" and "policy.approval_label" must name different labels',
      '"brief.extra" is "../notes.md", expected a path inside the repository, relative to armada.toml',
    ]);
  });

  test("the template init writes is a valid file for the project it names", () => {
    const text = configTemplate({
      name: "Widgets",
      slug: "widgets",
      programRoot: "DEMO-1",
      repository: "acme/widgets",
    });
    // The plan policy and the conventions file are written commented, with their defaults.
    expect(text).toMatch(/\[policy\][^[]*\n# plans = "approve"[^[]*\n# approval_label = "needs-plan-approval"/);
    expect(text).toContain("[brief]\n# extra = ");
    const { conductor, ...rest } = parseConfig(text);
    const { conductor: _none, ...demo } = parseConfig(DEMO_TOML);
    expect(rest).toEqual(demo);
    expect(conductor).toEqual({
      defaultProfile: "opus",
      profiles: {
        opus: {
          runtime: "conductor",
          agent: "claude",
          model: "opus-5-5-1m",
          effort: "high",
          fastMode: false,
          when: "front end: dashboard pages, components, styles, design, UI copy",
        },
        codex: {
          runtime: "conductor",
          agent: "codex",
          model: "gpt-6.1-sol",
          effort: "high",
          fastMode: false,
          when: "back end: CLI, core rules, API, database, migrations, tests, docs",
        },
        debug: {
          runtime: "conductor",
          agent: "codex",
          model: "gpt-6.1-sol",
          effort: "xhigh",
          fastMode: false,
          when: "a bug to diagnose",
        },
      },
      routing: [
        { labels: ["web"], profile: "opus" },
        { labels: ["api"], profile: "codex" },
        { labels: ["Bug"], profile: "debug" },
      ],
    });
  });

  test("Conductor profiles need an agent, a model and an effort, and the default must exist", () => {
    const text = DEMO_TOML.concat(
      '\n[conductor]\ndefault_profile = "fast"\n[conductor.profiles.opus]\nagent = "claude"\nmodel = "opus-5-5-1m"\nfast_mode = "yes"\nmodle = "x"\n',
    );
    expect(problemsOf(text)).toEqual([
      '"conductor.profiles.opus.fast_mode" must be true or false',
      'missing required key "conductor.profiles.opus.effort"',
      '"conductor.default_profile" is "fast", but there is no [conductor.profiles.fast]',
      'unknown key "conductor.profiles.opus.modle"',
    ]);
  });

  test("profile when rules are optional nonempty strings and replace the need for a routing default", () => {
    const base = `${DEMO_TOML}\n[conductor.profiles.backend]\nagent = "codex"\nmodel = "m"\neffort = "high"\n`;
    expect(parseConfig(`${base}when = " CLI, core rules and API "\n`).conductor.profiles.backend?.when).toBe(
      "CLI, core rules and API",
    );
    for (const value of ['"  "', "true", "12"])
      expect(() => parseConfig(`${base}when = ${value}\n`)).toThrow("conductor.profiles.backend.when");
    expect(
      parseConfig(`${base}when = "back end"\n[[conductor.routing]]\nlabels = ["api"]\nprofile = "backend"\n`).conductor
        .defaultProfile,
    ).toBeNull();
  });

  test("a profile runs on conductor or claude-code, and a claude-code profile runs claude", () => {
    const local =
      '\n[conductor.profiles.local]\nruntime = "claude-code"\nagent = "claude"\nmodel = "opus"\neffort = "high"\n';
    expect(parseConfig(DEMO_TOML.concat(local)).conductor.profiles.local).toEqual({
      runtime: "claude-code",
      agent: "claude",
      model: "opus",
      effort: "high",
      fastMode: false,
    });
    const text = DEMO_TOML.concat(
      '\n[conductor.profiles.local]\nruntime = "claude-code"\nagent = "codex"\nmodel = "opus"\neffort = "high"\n',
      '[conductor.profiles.cloud]\nruntime = "cloud"\nagent = "claude"\nmodel = "opus"\neffort = "high"\n',
    );
    expect(problemsOf(text)).toEqual([
      '"conductor.profiles.local.agent" must be "claude" with runtime = "claude-code"',
      '"conductor.profiles.cloud.runtime" must be one of "conductor", "claude-code"',
    ]);
  });

  test("routing rules need labels and a profile, and a default_profile for the tickets they miss", () => {
    const text = DEMO_TOML.concat(
      '\n[conductor.profiles.opus]\nagent = "claude"\nmodel = "opus-5-5-1m"\neffort = "high"\n',
      '[[conductor.routing]]\nlabels = []\nprofile = "opus"\n',
      '[[conductor.routing]]\nlabels = ["web"]\nprofil = "opus"\n',
      '[[conductor.routing]]\nlabels = ["-"]\nprofile = "opus"\n',
    );
    expect(problemsOf(text)).toEqual([
      '"conductor.routing[1].labels" must be a non-empty list of Linear label names, each with a letter or digit',
      'missing required key "conductor.routing[2].profile"',
      '"conductor.routing[3].labels" must be a non-empty list of Linear label names, each with a letter or digit',
      '"conductor.default_profile" is required with [[conductor.routing]], for tickets no rule matches',
      'unknown key "conductor.routing[2].profil"',
    ]);
  });

  test("broken TOML reports where it broke", () => {
    expect(problemsOf("[project\nname = 1")[0]).toMatch(/^not valid TOML \(line 1, column \d+\)$/);
  });
});
