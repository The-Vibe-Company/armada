import { describe, expect, test } from "bun:test";
import { ConfigError, configTemplate, parseConfig, resolveProfile } from "../src/config.ts";
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
      policy: { silentAfterMinutes: 15 },
      conductor: { defaultProfile: null, profiles: {} },
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
      .concat('\n[policy]\nsilence_minutes = -1\n[gates]\nrequired_checks = 1\nlocal_commands = [""]\n');
    expect(problemsOf(text)).toEqual([
      '"tracker.labels.runtimes" must be a non-empty list of names',
      '"policy.silence_minutes" must be a positive number',
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

  test("the template init writes is a valid file for the project it names", () => {
    const text = configTemplate({
      name: "Widgets",
      slug: "widgets",
      programRoot: "DEMO-1",
      repository: "acme/widgets",
    });
    const { conductor, ...rest } = parseConfig(text);
    const { conductor: _none, ...demo } = parseConfig(DEMO_TOML);
    expect(rest).toEqual(demo);
    expect(conductor).toEqual({
      defaultProfile: "opus",
      profiles: {
        opus: { agent: "claude", model: "opus-5-5-1m", effort: "high", fastMode: false },
        codex: { agent: "codex", model: "gpt-6.1-sol", effort: "high", fastMode: false },
      },
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

  test("brief picks --profile, then default_profile, then the only profile", () => {
    const profile = (name: string) =>
      `\n[conductor.profiles.${name}]\nagent = "claude"\nmodel = "m-${name}"\neffort = "high"\n`;
    const two = parseConfig(DEMO_TOML + profile("a") + profile("b"));
    expect(resolveProfile(two, "b")).toMatchObject({ name: "b", profile: { model: "m-b" } });
    expect(resolveProfile(two, null)).toMatchObject({ problem: expect.stringContaining("pass --profile (a, b)") });
    expect(resolveProfile(two, "c")).toMatchObject({ problem: 'no Conductor profile "c" (available: a, b)' });
    expect(resolveProfile(two, "toString")).toMatchObject({ profile: null });
    expect(resolveProfile(parseConfig(DEMO_TOML + profile("a")), null)).toMatchObject({ name: "a" });
    expect(
      resolveProfile(
        parseConfig(`${DEMO_TOML}[conductor]\ndefault_profile = "b"\n${profile("a")}${profile("b")}`),
        null,
      ),
    ).toMatchObject({ name: "b" });
    expect(resolveProfile(parseConfig(DEMO_TOML), null)).toEqual({ name: null, profile: null, problem: null });
  });

  test("broken TOML reports where it broke", () => {
    expect(problemsOf("[project\nname = 1")[0]).toMatch(/^not valid TOML \(line 1, column \d+\)$/);
  });
});
