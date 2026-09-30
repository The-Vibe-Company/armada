import { describe, expect, test } from "bun:test";
import { ConfigError, parseConfig } from "../src/config.ts";
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
        labels: { phaseGroup: "Agent phase", runtimeGroup: "Agent runtime" },
      },
      github: { repository: "acme/widgets" },
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
      .concat("\n[policy]\nsilent_after_minutes = -1\n");
    expect(problemsOf(text)).toEqual([
      '"policy.silent_after_minutes" must be a positive number',
      '"project.slug" is "My Widgets", expected lowercase letters, digits and dashes',
      '"github.repository" is "widgets", expected owner/name',
    ]);
  });

  test("broken TOML reports where it broke", () => {
    expect(problemsOf("[project\nname = 1")[0]).toMatch(/^not valid TOML \(line 1, column \d+\)$/);
  });
});
