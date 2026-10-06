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
  test("spec title styles default to N, accept totals explicitly, and reject other values", () => {
    expect(parseConfig(DEMO_TOML).tracker.specTitles).toBe("N");
    expect(parseConfig(DEMO_TOML.replace("[tracker]", '[tracker]\nspec_titles = "N/M"')).tracker.specTitles).toBe(
      "N/M",
    );
    for (const value of ['"M"', "1", '"n"'])
      expect(problemsOf(DEMO_TOML.replace("[tracker]", `[tracker]\nspec_titles = ${value}`))).toContain(
        '"tracker.spec_titles" must be "N" or "N/M"',
      );
    expect(
      configTemplate({ name: "Widgets", slug: "widgets", programRoot: "DEMO-1", repository: "acme/widgets" }),
    ).toContain('spec_titles = "N"');
  });
  test("silence and quiet thresholds are independently configurable positive minutes", () => {
    const configured = parseConfig(`${DEMO_TOML}\n[policy]\nsilence_minutes = 12\nquiet_minutes = 50\n`);
    expect([configured.policy.silentAfterMinutes, configured.policy.quietAfterMinutes]).toEqual([12, 50]);
    expect(problemsOf(`${DEMO_TOML}\n[policy]\nquiet_minutes = 0\n`)).toContain(
      '"policy.quiet_minutes" must be a positive number',
    );
  });
  test("a minimal file gets the protocol defaults", () => {
    expect(parseConfig(DEMO_TOML)).toEqual({
      jobs: {},
      project: { name: "Widgets", slug: "widgets" },
      tracker: {
        programRoot: "DEMO-1",
        specTitles: "N",
        lint: {
          inShort: "## In short",
          inShortParts: ["What changes", "Why", "Done when", "Depends on"],
          titleMax: 60,
          severity: "warning",
        },
        language: "en",
        readyLabel: "ready-for-agent",
        parkedLabel: "parked",
        labels: {
          phaseGroup: "Agent phase",
          runtimeGroup: "Agent runtime",
          runtimes: ["Claude Code", "Codex", "Conductor", "Herdr"],
        },
      },
      github: { repository: "acme/widgets" },
      ci: { failurePatterns: [] },
      gates: { requiredChecks: [], localCommands: [] },
      policy: {
        attachmentsPerTicket: 20,
        attachmentsProjectMb: 200,
        attachmentsRetentionDays: 30,
        silentAfterMinutes: 15,
        quietAfterMinutes: 45,
        coordinatorMinutes: 10,
        notStartedMinutes: 10,
        plans: "approve",
        preApprovedLabel: "plan-approved",
        approvalLabel: "needs-plan-approval",
        mergeApproval: null,
        validations: [],
      },
      reservations: [],
      brief: { extra: null },
      secrets: { names: [] },
      conductor: { defaultProfile: null, profiles: {}, routing: [] },
      herdr: { defaultProfile: null, profiles: {}, routing: [] },
    });
  });

  test("the parked label is configurable", () => {
    const toml = DEMO_TOML.replace("[tracker]\n", '[tracker]\nparked_label = "on-hold"\n');
    expect(parseConfig(toml).tracker.parkedLabel).toBe("on-hold");
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

  test("which merges and which kinds of tickets need the owner, in plain words", () => {
    const config = parseConfig(
      DEMO_TOML.concat(
        '\n[policy]\nmerge_approval = " merge on your own, except front end "\n[[policy.validation]]\nwhen = "a design ticket"\nthen = "attach the design and wait"\n',
      ),
    );
    expect(config.policy.mergeApproval).toBe("merge on your own, except front end");
    expect(config.policy.validations).toEqual([{ when: "a design ticket", show: "attach the design and wait" }]);
    expect(
      problemsOf(
        DEMO_TOML.concat('\n[policy]\nmerge_approval = ""\n[[policy.validation]]\nwhen = "a design"\nshow = "x"\n'),
      ),
    ).toEqual([
      '"policy.merge_approval" must be a non-empty string',
      'unknown key "policy.validation[1].show"',
      'missing required key "policy.validation[1].then"',
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
    expect(text).toContain("\n# merge_approval = ");
    expect(text).toContain("\n# [[policy.validation]]\n# when = ");
    expect(text).toContain('runtimes = ["Claude Code", "Codex", "Conductor", "Herdr"]');
    expect(text).toContain("# [herdr]");
    expect(text).toContain("# [herdr.profiles.claude]");
    expect(text).toContain('# permissions = "ask"');
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

  test("native Conductor project and base overrides are optional and reject invalid ids or branches", () => {
    expect(
      parseConfig(`${DEMO_TOML}\n[conductor]\nproject_id = "project-1"\nbase_branch = "release/widget"`).conductor,
    ).toMatchObject({ projectId: "project-1", baseBranch: "release/widget" });
    for (const branch of ["release/.hidden", "topic.lock/child", "/topic", ".hidden"]) {
      expect(
        problemsOf(`${DEMO_TOML}\n[conductor]\nbase_branch = "${branch}"`).some((p) =>
          p.includes("conductor.base_branch"),
        ),
      ).toBe(true);
    }
    for (const key of ["project_id", "base_branch"]) {
      expect(
        problemsOf(`${DEMO_TOML}\n[conductor]\n${key} = "-invalid name"`).some((p) => p.includes(`conductor.${key}`)),
      ).toBe(true);
    }
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

  test("Herdr profiles require a supported harness and default extra arguments to an empty list", () => {
    const config = parseConfig(
      `${DEMO_TOML}
[herdr]
default_profile = "codex"
[herdr.profiles.codex]
harness = "codex"
model = "gpt"
effort = "high"
extra_args = [" --json ", "--verbose"]
when = "back end work"
`,
    );
    expect(config.herdr).toEqual({
      defaultProfile: "codex",
      profiles: {
        codex: {
          harness: "codex",
          model: "gpt",
          effort: "high",
          extraArgs: [" --json ", "--verbose"],
          when: "back end work",
        },
      },
      routing: [],
    });
    const defaults = parseConfig(
      `${DEMO_TOML}
[herdr.profiles.claude]
harness = "claude"
model = "sonnet"
effort = "high"
`,
    ).herdr.profiles.claude;
    expect(defaults?.extraArgs).toEqual([]);
  });

  test("Herdr permissions are optional, validated, and cannot claim ask with a bypass flag", () => {
    const explicit = parseConfig(
      `${DEMO_TOML}
[herdr.profiles.codex]
harness = "codex"
model = "gpt"
effort = "high"
permissions = "full"
`,
    ).herdr.profiles.codex;
    expect(explicit?.permissions).toBe("full");
    expect(
      parseConfig(
        `${DEMO_TOML}
[herdr.profiles.codex]
harness = "codex"
model = "gpt"
effort = "high"
`,
      ).herdr.profiles.codex,
    ).not.toHaveProperty("permissions");
    expect(
      problemsOf(
        `${DEMO_TOML}
[herdr.profiles.codex]
harness = "codex"
model = "gpt"
effort = "high"
permissions = "always"
`,
      ),
    ).toContain('"herdr.profiles.codex.permissions" must be "ask" or "full"');
    expect(
      problemsOf(
        `${DEMO_TOML}
[herdr.profiles.codex]
harness = "codex"
model = "gpt"
effort = "high"
permissions = "ask"
extra_args = ["--dangerously-bypass-approvals-and-sandbox"]
`,
      ),
    ).toEqual([
      '"herdr.profiles.codex.permissions" = "ask" cannot be combined with "--dangerously-bypass-approvals-and-sandbox" in "herdr.profiles.codex.extra_args"',
    ]);
  });

  test("DeepSeek profiles accept DeepSeek models across providers", () => {
    const profile = (model: string) => `${DEMO_TOML}
[herdr.profiles.deepseek]
harness = "deepseek"
model = "${model}"
effort = "high"
`;
    for (const model of [
      "deepseek/deepseek-reasoner",
      "opencode/deepseek-v4-pro",
      "openrouter/deepseek/deepseek-chat",
      "opencode/deepseek-v4.1-flash#high",
    ])
      expect(parseConfig(profile(model)).herdr.profiles.deepseek?.harness).toBe("deepseek");
    for (const arg of ["--model", "--model=openai/model-a", "-m", "-mopenai/model-a"])
      expect(problemsOf(`${profile("deepseek/deepseek-reasoner")}extra_args = ["${arg}"]`)).toContain(
        '"herdr.profiles.deepseek.extra_args" must not override the DeepSeek model; use "herdr.profiles.deepseek.model"',
      );
    for (const harness of ["opencode", "deepseek"]) {
      const text = profile("").replace('harness = "deepseek"', `harness = "${harness}"`);
      expect(parseConfig(text).herdr.profiles.deepseek?.model).toBe("");
      expect(parseConfig(text.replace('model = ""', "")).herdr.profiles.deepseek?.model).toBe("");
    }
    // The interactive preflight repairs unavailable and wrong-family selections.
    expect(parseConfig(profile("openai/model-a")).herdr.profiles.deepseek?.model).toBe("openai/model-a");
  });

  test("Herdr profile and routing values name their invalid keys", () => {
    const text = `${DEMO_TOML}
[herdr]
default_profile = "missing"
[herdr.profiles.codex]
harness = "gemini"
model = "gpt"
effort = "high"
extra_args = ["", 1]
[[herdr.routing]]
labels = ["api"]
profile = "missing"
`;
    expect(problemsOf(text)).toEqual([
      '"herdr.profiles.codex.harness" must be one of "claude", "codex", "opencode", "deepseek"',
      '"herdr.profiles.codex.extra_args" must be a list of non-empty argument strings',
      '"herdr.default_profile" is "missing", but there is no [herdr.profiles.missing]',
      '"herdr.routing[1].profile" is "missing", but there is no [herdr.profiles.missing]',
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

test("declared reservation keys are optional, descriptive and unique", () => {
  const declaration = '\n[[reservations]]\nkey = "db-migration"\nwhat = "the next schema version"\nnumbered = true\n';
  expect(parseConfig(DEMO_TOML + declaration).reservations).toEqual([
    { key: "db-migration", what: "the next schema version", numbered: true },
  ]);
  expect(problemsOf(DEMO_TOML + declaration + declaration).join(" ")).toContain("repeats db-migration");
  expect(problemsOf(DEMO_TOML + declaration.replace("numbered = true", 'numbered = "yes"')).join(" ")).toContain(
    'numbered" must be true or false',
  );
});

test("tracker lint is opt-in with configurable defaults and rejects invalid rules", () => {
  expect(parseConfig(`${DEMO_TOML}\n[tracker.lint]`).tracker.lint.severity).toBe("error");
  expect(
    parseConfig(`${DEMO_TOML}\n[tracker.lint]\nin_short = "## Résumé"\nin_short_parts = ["Pourquoi"]\ntitle_max = 80`)
      .tracker.lint,
  ).toEqual({ inShort: "## Résumé", inShortParts: ["Pourquoi"], titleMax: 80, severity: "error" });
  for (const field of [
    'in_short = "Summary"',
    "in_short_parts = []",
    "title_max = 0",
    "title_max = 1.5",
    "unknown = true",
  ])
    expect(problemsOf(`${DEMO_TOML}\n[tracker.lint]\n${field}`).join(" ")).toContain("tracker.lint");
  expect(problemsOf(DEMO_TOML.replace("[tracker]", "[tracker]\nlint = false")).join(" ")).toContain("tracker.lint");
});
