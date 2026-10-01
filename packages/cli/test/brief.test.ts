import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machinePaths, NPM_REGISTRY_URL, readWatchState, updateWatchState } from "@armada/core";
import { ARMADA_URL, DEMO_TOML, type FakeVault, fakeArmada, NOW, recordedFetch } from "../../core/test/support.ts";
import { version } from "../package.json" with { type: "json" };
import { type Io, run } from "../src/cli.ts";

const TOML = `${DEMO_TOML}
[conductor]
default_profile = "opus"

[conductor.profiles.opus]
agent = "claude"
model = "opus-5-5-1m"
effort = "high"

[conductor.profiles.codex]
agent = "codex"
model = "gpt-6.1-sol"
effort = "high"
fast_mode = true

[conductor.profiles.local]
runtime = "claude-code"
agent = "claude"
model = "opus"
effort = "high"

[[conductor.routing]]
labels = ["web"]
profile = "opus"

[[conductor.routing]]
labels = ["api"]
profile = "codex"
`;

const note = (id: string, createdAt: string, body: string, name = "Ada Worker") => ({
  id,
  createdAt,
  body,
  user: { name },
});

/** DEMO-13 is blocked by DEMO-10 (done, handed back) and carries one coordinator decision. */
const BRIEF_RESPONSE = {
  data: {
    issue: {
      identifier: "DEMO-13",
      title: "Show a sign-in page",
      url: "https://linear.app/acme/issue/DEMO-13",
      branchName: "feature/demo-13-show-a-sign-in-page",
      description: "## In short\n\nA page with an email field.",
      state: { name: "Todo", type: "unstarted" },
      labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: "Feature" }, { name: "Web" }] },
      parent: {
        identifier: "DEMO-2",
        title: "Spec 1/2 — Sign in with email",
        url: "https://linear.app/acme/issue/DEMO-2",
      },
      comments: {
        pageInfo: { hasNextPage: false },
        nodes: [note("c-decision-1", "2026-03-03T12:00:00.000Z", "Decision: reuse the account form.", "Coordinator")],
      },
      inverseRelations: {
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            type: "blocks",
            issue: {
              identifier: "DEMO-10",
              title: "Store user accounts",
              url: "https://linear.app/acme/issue/DEMO-10",
              state: { name: "Done", type: "completed" },
              comments: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  note("c-10-a", "2026-03-02T11:00:00.000Z", "Agent status: planning — claimed"),
                  note(
                    "c-10-b",
                    "2026-03-03T10:00:00.000Z",
                    "Agent status: ready-to-merge — PR #4, head abc, CI green\n\n## For the next tickets\nAccounts live in `accounts.ts`.",
                  ),
                  note("c-10-c", "2026-03-03T11:00:00.000Z", "Merged, thanks.", "Coordinator"),
                ],
              },
            },
          },
        ],
      },
    },
  },
};

// Planted where a careless brief could leak them: the environment it inspects.
const SECRETS = {
  LINEAR_API_KEY: "lin_api_SECRET_value_1",
};

function briefIo(
  env: Record<string, string> = SECRETS,
  response: object = BRIEF_RESPONSE,
  more: Record<string, unknown[]> = {},
  files: Record<string, string> = { "/work/widgets/armada.toml": TOML },
) {
  const out: string[] = [];
  const err: string[] = [];
  const { fetch, calls } = recordedFetch({
    linear: (r) => {
      Object.assign(r, { Brief: [response], ...more });
    },
  });
  const io: Io = {
    cwd: "/work/widgets",
    env,
    readFile: async (path) => files[path] ?? null,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ghToken: () => null,
    fetch,
    now: () => NOW,
  };
  return { io, calls, out: () => out.join(""), err: () => err.join("") };
}

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe("armada brief", () => {
  test("semantic rules ask without a launch or watch write; prompt refuses until a reasoned choice", async () => {
    const toml = TOML.replace(
      "[conductor.profiles.opus]",
      '[conductor.profiles.opus]\nwhen = "front end: pages and UI copy"',
    ).replace("[conductor.profiles.codex]", '[conductor.profiles.codex]\nwhen = "back end: CLI and core rules"');
    const response = structuredClone(BRIEF_RESPONSE);
    response.data.issue.labels.nodes = [{ name: "Feature" }];
    response.data.issue.description += "\n\n## Technical detail\n\nDo not include this in the choice summary.";
    const files = { "/work/widgets/armada.toml": toml };
    const b = briefIo(SECRETS, response, {}, files);
    expect(await run(["brief", "DEMO-13"], b.io)).toBe(0);
    expect(b.out()).toContain("Choose a profile");
    expect(b.out()).toContain("DEMO-13 — Show a sign-in page");
    expect(b.out()).toContain("A page with an email field.");
    expect(b.out()).toContain("opus: front end: pages and UI copy");
    expect(b.out()).toContain("codex: back end: CLI and core rules");
    expect(b.out()).not.toContain("Technical detail");
    expect(b.out()).not.toContain("armada claim");
    const j = briefIo(SECRETS, response, {}, files);
    expect(await run(["brief", "DEMO-13", "--json"], j.io)).toBe(0);
    expect(JSON.parse(j.out()).selection.profiles).toContainEqual({
      name: "codex",
      when: "back end: CLI and core rules",
    });
    const p = briefIo(SECRETS, response, {}, files);
    expect(await run(["brief", "DEMO-13", "--prompt"], p.io)).toBe(2);
    expect(p.err()).toContain('armada brief DEMO-13 --profile <name> --reason "<why>"');
    expect(p.out()).toBe("");
    const chosen = briefIo(SECRETS, response, {}, files);
    expect(
      await run(
        ["brief", "DEMO-13", "--prompt", "--profile", "opus", "--reason", "mostly dashboard components"],
        chosen.io,
      ),
    ).toBe(0);
    expect(chosen.out()).toContain("--profile opus --reason 'mostly dashboard components'");
    const labelled = briefIo(SECRETS, BRIEF_RESPONSE, {}, files);
    expect(await run(["brief", "DEMO-13", "--prompt"], labelled.io)).toBe(0);
    expect(labelled.out()).toContain("--profile opus");
  });

  test("prints the launch settings, then the prompt: claim first, blockers' hand-backs, decisions, workers in flight", async () => {
    const b = briefIo({ LINEAR_API_KEY: SECRETS.LINEAR_API_KEY });
    expect(await run(["brief", "demo-13"], b.io)).toBe(0);
    const text = b.out();
    expect(text).toContain(
      'Profile:     opus: agent claude, model opus-5-5-1m, effort high\nChosen by:   rule 1 of [[conductor.routing]] (label "Web")\n',
    );
    expect(text).toContain("Branch:      feature/demo-13-show-a-sign-in-page");
    expect(text).toMatch(/ {2}LINEAR_API_KEY +required {2}set in this shell /);
    // The fleet's live data is reached through Armada: no database variable to pass.
    expect(text).not.toContain("ARMADA_TURSO");
    expect(text).toContain("ARMADA_TICKET=DEMO-13");
    // The last line is for the coordinator: once launched, a worker is in flight.
    expect(text).toEndWith("\n----- once launched -----\nNo worker in flight — nothing to watch.\n");

    const prompt = text.slice(text.indexOf("# DEMO-13 — Show a sign-in page"));
    const at = [
      "npm install -g @the-vibe-company/armada@",
      "> ## For the next tickets",
      "> Decision: reuse the account form.",
      "## Workers in flight",
    ].map((s) => prompt.indexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(prompt).toContain(
      `\nnpm install -g @the-vibe-company/armada@${version}\narmada claim DEMO-13 --runtime conductor --handle "$CONDUCTOR_WORKSPACE_ID/$CONDUCTOR_SESSION_ID" --branch feature/demo-13-show-a-sign-in-page --profile opus\n`,
    );
    expect(prompt).toContain("git branch -m feature/demo-13-show-a-sign-in-page");
    expect(prompt).toContain("## Ticket\n\n> ## In short\n>\n> A page with an email field.\n");
    expect(text).not.toContain("Warnings:");
    // The hand-back is the ready-to-merge comment, not the newer "Merged, thanks."
    expect(prompt).not.toContain("Merged, thanks.");
    expect(prompt).toContain(
      "- DEMO-11 — Send a sign-in link by email (implementing), branch `feature/demo-11-sign-in-link`, https://github.com/acme/widgets/pull/7",
    );
    expect(b.err()).toBe("");
  });

  test("the plan rule is one line of the prompt, and [brief] extra ends it under Project conventions", async () => {
    const b = briefIo();
    expect(await run(["brief", "DEMO-13", "--prompt"], b.io)).toBe(0);
    expect(b.out()).toContain(
      '## Plan\n\nPlans need the coordinator\'s approval for DEMO-13 (armada.toml [policy] plans = "approve"): post your plan with `armada report awaiting-approval --plan-file -` and wait for approval.\n',
    );
    expect(b.out()).not.toContain("## Project conventions");

    const toml = `${TOML}\n[policy]\nplans = "pre-approved"\n\n[brief]\nextra = "docs/workers.md"\n`;
    const conventions = "Run `make check` before you push.\nNever force-push: merge main instead.\n";
    const files = { "/work/widgets/armada.toml": toml, "/work/widgets/docs/workers.md": conventions };
    const c = briefIo(SECRETS, BRIEF_RESPONSE, {}, files);
    expect(await run(["brief", "DEMO-13", "--prompt"], c.io)).toBe(0);
    expect(c.out()).toContain(
      'Plans are pre-approved for DEMO-13 (armada.toml [policy] plans = "pre-approved"): post your plan with `armada report implementing --plan-file -` and go on.\n',
    );
    expect(c.out()).toEndWith(`\n## Project conventions\n\n${conventions}`);
    expect(c.err()).toBe("");

    // A missing file is a warning, and the brief goes out without the section.
    const m = briefIo(SECRETS, BRIEF_RESPONSE, {}, { "/work/widgets/armada.toml": toml });
    expect(await run(["brief", "DEMO-13"], m.io)).toBe(0);
    expect(m.out()).toContain('Plans:       pre-approved (armada.toml [policy] plans = "pre-approved")\n');
    expect(m.out()).toContain(
      "  - [brief] extra names docs/workers.md, which could not be read; the brief has no project conventions\n",
    );
    expect(m.out()).not.toContain("## Project conventions");
  });

  test("--prompt prints only the prompt and --json the whole brief with the chosen profile", async () => {
    const override = ["--profile", "codex", "--reason", "it's a session bug"];
    const p = briefIo();
    expect(await run(["brief", "DEMO-13", "--prompt", ...override], p.io)).toBe(0);
    expect(p.out().startsWith("# DEMO-13 — Show a sign-in page\n")).toBe(true);
    expect(p.out()).not.toContain("keep watching");

    const j = briefIo();
    expect(await run(["brief", "DEMO-13", "--json", ...override], j.io)).toBe(0);
    const brief = JSON.parse(j.out());
    expect(brief.watch.line).toBe("No worker in flight — nothing to watch.");
    expect(brief.runtime).toBe("conductor");
    expect(brief.profile).toEqual({
      name: "codex",
      runtime: "conductor",
      agent: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      fastMode: true,
    });
    expect(brief.routing).toEqual({
      source: "requested",
      rule: null,
      routed: "opus",
      reason: "it's a session bug",
      why: `--profile, instead of "opus" from rule 1 of [[conductor.routing]] (label "Web"): it's a session bug`,
    });
    // The worker's claim records the override and its reason.
    expect(brief.claimCommand).toEndWith(` --profile codex --reason 'it'\\''s a session bug'`);
    expect(brief.prompt).toBe(p.out());
    expect(brief.environment.map((v: { name: string }) => v.name)).toEqual(["LINEAR_API_KEY", "ARMADA_TICKET"]);
  });

  test("the brief pins a version npm serves: else the newest published one, with a warning; offline it only warns", async () => {
    const briefWith = async (npm: () => Promise<Response>) => {
      const b = briefIo();
      const linear = b.io.fetch;
      b.io.fetch = (url, init) => (url === NPM_REGISTRY_URL ? npm() : (linear?.(url, init) ?? fetch(url)));
      expect(await run(["brief", "DEMO-13", "--json"], b.io)).toBe(0);
      return JSON.parse(b.out()) as { install: string; fallback: string; prompt: string; warnings: string[] };
    };
    const pkg = "@the-vibe-company/armada";

    // A release npm does not serve yet: the newest published version below it, never a prerelease.
    const behind = await briefWith(async () =>
      Response.json({ versions: { "0.1.9": {}, "0.2.5": {}, [`${version}-rc.1`]: {} } }),
    );
    expect([behind.install, behind.fallback]).toEqual([
      `npm install -g ${pkg}@0.2.5`,
      `npm exec --yes --package=${pkg}@0.2.5 -- armada`,
    ]);
    expect(behind.prompt).toContain(
      `This installs Armada 0.2.5, the newest on npm (the coordinator runs ${version}, not published yet).`,
    );
    expect(behind.warnings).toContain(
      `armada ${version} is not on npm yet: this brief pins 0.2.5, the newest published version. The skills of this checkout may describe commands 0.2.5 lacks; publish ${version} (the release pull request) and brief again to launch with it`,
    );

    const none = await briefWith(async () => Response.json({ versions: { "99.0.0": {} } }));
    expect(none.install).toBe(`npm install -g ${pkg}@${version}`);
    expect(none.warnings).toContain(
      `armada ${version} is not on npm, nor any older version: the worker's install and its fallback line fail until it is published`,
    );

    const offline = await briefWith(async () => {
      throw new TypeError("fetch failed");
    });
    expect(offline.install).toBe(`npm install -g ${pkg}@${version}`);
    expect(offline.prompt).toContain("This installs the coordinator's Armada version.");
    expect(offline.warnings).toContain(
      `could not check that armada ${version} is on npm (fetch failed); if it is not published yet, the worker's install fails`,
    );
  });

  test("a claude-code profile names its guide, and the prompt puts the subagent in its own worktree first", async () => {
    const b = briefIo();
    expect(await run(["brief", "DEMO-13", "--profile", "local", "--reason", "short ticket"], b.io)).toBe(0);
    const text = b.out();
    expect(text).toContain(
      "Runtime:     claude-code (follow the armada-runtime-claude-code skill to launch)\nProfile:     local: agent claude, model opus, effort high (not applied by the Agent tool)\n",
    );
    const prompt = text.slice(text.indexOf("# DEMO-13 — Show a sign-in page"));
    const at = ["## Before anything: your own worktree", "`EnterWorktree`", "## Then: install Armada"].map((s) =>
      prompt.indexOf(s),
    );
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The handle is the subagent's name, which the coordinator gives it at launch.
    expect(prompt).toContain(
      "\narmada claim DEMO-13 --runtime claude-code --handle demo-13 --branch feature/demo-13-show-a-sign-in-page --profile local --reason 'short ticket'\n",
    );
    expect(prompt).toContain("Your worktree starts on a branch Claude Code named");
    // The coordinator's ARMADA_TICKET reaches the subagent too: every command names the ticket.
    expect(prompt).toContain("Pass `--ticket DEMO-13` to every `armada report`, `ask` and `release`");
    expect(prompt).not.toContain("CONDUCTOR");
    // Nothing can be set in a subagent's environment alone.
    expect(text).not.toContain("ARMADA_TICKET=");
  });

  test("no secret value from the environment appears in any output", async () => {
    for (const flags of [[], ["--prompt"], ["--json"]]) {
      const b = briefIo();
      expect(await run(["brief", "DEMO-13", ...flags], b.io)).toBe(0);
      const all = b.out() + b.err();
      for (const secret of Object.values(SECRETS)) expect(all).not.toContain(secret);
      // The key still reaches Linear, only in the request header.
      expect(b.calls.every((c) => c.authorization === SECRETS.LINEAR_API_KEY)).toBe(true);
    }
  });

  test("warns about a blocker still open, not about a canceled one", async () => {
    const response = structuredClone(BRIEF_RESPONSE);
    const blocker = response.data.issue.inverseRelations.nodes[0]?.issue;
    if (!blocker) throw new Error("fixture has no blocker");
    blocker.state = { name: "Canceled", type: "canceled" };
    const canceled = briefIo(SECRETS, response);
    expect(await run(["brief", "DEMO-13"], canceled.io)).toBe(0);
    expect(canceled.out()).not.toContain("Warnings:");

    blocker.state = { name: "In Progress", type: "started" };
    const open = briefIo(SECRETS, response);
    expect(await run(["brief", "DEMO-13"], open.io)).toBe(0);
    expect(open.out()).toContain("Warnings:\n  - DEMO-13 is blocked by DEMO-10 (In Progress)\n");
  });

  test("relations and comments longer than one page are read to the end", async () => {
    const response = structuredClone(BRIEF_RESPONSE);
    Object.assign(response.data.issue.inverseRelations.pageInfo, { hasNextPage: true, endCursor: "r1" });
    const later = {
      type: "blocks",
      issue: {
        identifier: "DEMO-12",
        title: "Remember the last email used",
        url: "https://linear.app/acme/issue/DEMO-12",
        state: { name: "In Progress", type: "started" },
        comments: {
          pageInfo: { hasNextPage: true, endCursor: "k1" },
          nodes: [note("c-12-a", "2026-03-03T09:00:00.000Z", "Agent status: planning — claimed")],
        },
      },
    };
    const handBack = note(
      "c-12-b",
      "2026-03-03T13:00:00.000Z",
      "Agent status: ready-to-merge — PR #5\n\n## For the next tickets\nThe last email lives in `recent.ts`.",
    );
    const b = briefIo(SECRETS, response, {
      MoreBriefRelations: [
        { data: { issue: { inverseRelations: { pageInfo: { hasNextPage: false }, nodes: [later] } } } },
      ],
      MoreBriefComments: [{ data: { issue: { comments: { pageInfo: { hasNextPage: false }, nodes: [handBack] } } } }],
    });
    expect(await run(["brief", "DEMO-13"], b.io)).toBe(0);
    expect(b.calls.filter((c) => c.operation.startsWith("MoreBrief")).map((c) => [c.operation, c.variables])).toEqual([
      ["MoreBriefRelations", { id: "DEMO-13", after: "r1" }],
      ["MoreBriefComments", { id: "DEMO-12", after: "k1" }],
    ]);
    expect(b.out()).toContain("The last email lives in `recent.ts`.");
    expect(b.out()).toContain("Warnings:\n  - DEMO-13 is blocked by DEMO-12 (In Progress)\n");
  });

  test("a key only in the credentials file is marked to load into the shell, and never shown", async () => {
    const home = await mkdtemp(join(tmpdir(), "armada-brief-"));
    homes.push(home);
    await mkdir(join(home, "armada"), { mode: 0o700 });
    await writeFile(join(home, "armada", "credentials"), `LINEAR_API_KEY=${SECRETS.LINEAR_API_KEY}\n`);
    await chmod(join(home, "armada", "credentials"), 0o600);
    const b = briefIo({ XDG_CONFIG_HOME: home });
    expect(await run(["brief", "DEMO-13"], b.io)).toBe(0);
    expect(b.out()).toMatch(/ {2}LINEAR_API_KEY +required {2}in credentials file /);
    expect(b.out() + b.err()).not.toContain(SECRETS.LINEAR_API_KEY);
  });

  test("a brief counts its ticket in flight at once, for the stop hook, even with --prompt", async () => {
    const home = await mkdtemp(join(tmpdir(), "armada-brief-"));
    homes.push(home);
    const paths = machinePaths({ XDG_CONFIG_HOME: home });
    if (!paths) throw new Error("no machine store");
    await updateWatchState(paths, "widgets", { root: "/work/widgets", inFlight: [] });
    const b = briefIo({ ...SECRETS, XDG_CONFIG_HOME: home });
    expect(await run(["brief", "DEMO-13", "--prompt"], b.io)).toBe(0);
    expect((await readWatchState(paths, "widgets"))?.inFlight).toEqual(["DEMO-13"]);
  });

  test("overriding the routed profile without a reason is a usage error", async () => {
    const b = briefIo();
    expect(await run(["brief", "DEMO-13", "--profile", "codex"], b.io)).toBe(2);
    expect(b.err()).toBe(
      'armada: DEMO-13 is routed to "opus" by rule 1 of [[conductor.routing]] (label "Web"); say why "codex" instead with --reason "<why>"\nNext: armada brief --help\n',
    );
    expect(b.out()).toBe("");
  });

  test("an unknown profile is a usage error, before any request", async () => {
    const b = briefIo();
    expect(await run(["brief", "DEMO-13", "--profile", "turbo"], b.io)).toBe(2);
    expect(b.err()).toBe(
      'armada: no Conductor profile "turbo" (available: opus, codex, local)\nNext: armada brief --help\n',
    );
    expect(b.calls).toEqual([]);
  });
});

describe("armada brief with a launch token", () => {
  /** A coordinator signed in to a fake Armada that keeps the organization's keys. */
  async function signedIn(vault: Partial<FakeVault> = {}, toml = TOML, response = BRIEF_RESPONSE) {
    const home = await mkdtemp(join(tmpdir(), "armada-brief-launch-"));
    homes.push(home);
    await mkdir(join(home, "armada"), { recursive: true });
    await writeFile(
      join(home, "armada", "credentials"),
      `ARMADA_SESSION_TOKEN=CANARY_coordinator_session\nARMADA_SIGNED_IN_TO=${ARMADA_URL}\n`,
    );
    const armada = fakeArmada({
      token: "CANARY_coordinator_session",
      vault: { linear: null, now: () => NOW, ...vault },
    });
    armada.sessions.add("CANARY_coordinator_session");
    const b = briefIo(
      { ...SECRETS, XDG_CONFIG_HOME: home, ARMADA_API_URL: ARMADA_URL },
      response,
      {},
      { "/work/widgets/armada.toml": toml },
    );
    const linear = b.io.fetch;
    b.io.fetch = (url, init) =>
      url.startsWith(ARMADA_URL) ? armada.fetch(url, init) : (linear?.(url, init) ?? fetch(url));
    return { ...b, armada };
  }

  test("an undecided or invalid semantic brief never mints a token, even when signed in", async () => {
    const toml = TOML.replace("[conductor.profiles.codex]", '[conductor.profiles.codex]\nwhen = "back end: CLI"');
    const response = structuredClone(BRIEF_RESPONSE);
    response.data.issue.labels.nodes = [];
    for (const flags of [[], ["--json"], ["--prompt"], ["--profile", "codex", "--prompt"]]) {
      const b = await signedIn({}, toml, response);
      expect(await run(["brief", "DEMO-13", ...flags], b.io)).toBe(flags.includes("--prompt") ? 2 : 0);
      expect(b.armada.calls.some((call) => call.path === "launch-tokens")).toBe(false);
      expect(b.armada.launches.size).toBe(0);
      const paths = machinePaths(b.io.env);
      if (!paths) throw new Error("no machine store");
      expect(await readWatchState(paths, "widgets")).toBeNull();
    }
    const b = await signedIn({}, toml, response);
    expect(await run(["brief", "DEMO-13", "--prompt", "--profile", "codex", "--reason", "CLI (back end)"], b.io)).toBe(
      0,
    );
    expect(b.armada.calls.filter((call) => call.path === "launch-tokens")).toHaveLength(1);
  });

  test("human and JSON briefs mint nothing and leave watch state unchanged", async () => {
    for (const flags of [[], ["--json"]]) {
      const brief = await signedIn();
      const paths = machinePaths(brief.io.env);
      if (!paths) throw new Error("no machine store");
      await updateWatchState(paths, "widgets", { root: "/work/widgets", inFlight: ["DEMO-8"] });
      const before = await readWatchState(paths, "widgets");
      expect(await run(["brief", "DEMO-13", ...flags], brief.io)).toBe(0);
      expect(brief.armada.calls.filter((call) => call.path === "launch-tokens")).toEqual([]);
      expect(brief.armada.launches.size).toBe(0);
      expect(await readWatchState(paths, "widgets")).toEqual(before);
      const text = brief.out();
      expect(text).toContain("a one-time token is made when you print the prompt (--prompt)");
      expect(text).not.toContain("armada_launch_");
      if (flags.length) expect(JSON.parse(text).launch).toBeNull();
    }
  });

  test("--prompt mints exactly one token and --profile-line keeps stdout unchanged", async () => {
    const plain = await signedIn();
    const profiled = await signedIn();
    const choice = ["--profile", "codex", "--reason", "CLI and core rules"];
    expect(await run(["brief", "DEMO-13", "--prompt", ...choice], plain.io)).toBe(0);
    expect(await run(["brief", "DEMO-13", "--prompt", "--profile-line", ...choice], profiled.io)).toBe(0);
    expect(profiled.out()).toBe(plain.out());
    expect(profiled.out()).toContain(`armada login --launch-token armada_launch_CANARY_1 --api-url ${ARMADA_URL}\n`);
    expect(profiled.out()).toContain("No key is needed in this workspace");
    expect(profiled.err()).toContain("Profile: codex: agent codex, model gpt-6.1-sol, effort high");
    expect(profiled.err()).toContain("CLI and core rules");
    expect(profiled.err()).not.toContain("armada_launch_");
    for (const brief of [plain, profiled]) {
      expect(brief.armada.calls.filter((call) => call.path === "launch-tokens")).toHaveLength(1);
      expect(brief.armada.launches.size).toBe(1);
    }
  });

  test("an Armada that refuses (no vault) leaves the prompt as before, with a warning; not signed in, the launch line says why", async () => {
    const b = await signedIn({ off: true });
    expect(await run(["brief", "DEMO-13", "--prompt"], b.io)).toBe(0);
    expect(b.out()).not.toContain("--launch-token");
    expect(b.out()).toContain("The coordinator set `LINEAR_API_KEY`");
    expect(b.err()).toContain(
      "armada: warning: no launch token: Armada made no launch token: this Armada keeps no keys",
    );

    const plain = briefIo();
    expect(await run(["brief", "DEMO-13"], plain.io)).toBe(0);
    expect(plain.out()).toContain("Launch:      a one-time token is made when you print the prompt (--prompt)\n");
    expect(plain.out()).not.toContain("--launch-token");
  });
});
