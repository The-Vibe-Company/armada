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
      gates: { requiredChecks: [] },
      policy: { silentAfterMinutes: 15 },
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
      .concat("\n[policy]\nsilence_minutes = -1\n[gates]\nrequired_checks = 1\n");
    expect(problemsOf(text)).toEqual([
      '"tracker.labels.runtimes" must be a non-empty list of names',
      '"policy.silence_minutes" must be a positive number',
      '"gates.required_checks" must be a list of check names',
      '"project.slug" is "My Widgets", expected lowercase letters, digits and dashes',
      '"github.repository" is "widgets", expected owner/name',
    ]);
  });

  test("a misspelled key in a known table is reported; unknown tables are left for newer readers", () => {
    const text = DEMO_TOML.replace('program_root = "DEMO-1"', 'program_root = "DEMO-1"\nredy_label = "go"').concat(
      '\n[conductor]\nprofile = "x"\n',
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
    expect(parseConfig(text)).toEqual(parseConfig(DEMO_TOML));
  });

  test("broken TOML reports where it broke", () => {
    expect(problemsOf("[project\nname = 1")[0]).toMatch(/^not valid TOML \(line 1, column \d+\)$/);
  });
});
