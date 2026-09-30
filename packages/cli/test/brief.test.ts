import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_TOML, NOW, recordedFetch } from "../../core/test/support.ts";
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
  ARMADA_TURSO_TOKEN: "turso_SECRET_value_2",
  ARMADA_TURSO_URL: "libsql://SECRET-db-3.turso.io",
};

function briefIo(env: Record<string, string> = SECRETS, response: object = BRIEF_RESPONSE) {
  const out: string[] = [];
  const err: string[] = [];
  const { fetch, calls } = recordedFetch({
    linear: (r) => {
      (r as Record<string, unknown[]>).Brief = [response];
    },
  });
  const io: Io = {
    cwd: "/work/widgets",
    env,
    readFile: async (path) => (path === "/work/widgets/armada.toml" ? TOML : null),
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
  test("prints the launch settings, then the prompt: claim first, blockers' hand-backs, decisions, workers in flight", async () => {
    const b = briefIo({ LINEAR_API_KEY: SECRETS.LINEAR_API_KEY });
    expect(await run(["brief", "demo-13"], b.io)).toBe(0);
    const text = b.out();
    expect(text).toContain("Profile:     opus: agent claude, model opus-5-5-1m, effort high\n");
    expect(text).toContain("Branch:      feature/demo-13-show-a-sign-in-page");
    expect(text).toMatch(/ {2}LINEAR_API_KEY +required {2}set in this shell /);
    expect(text).toMatch(/ {2}ARMADA_TURSO_URL +optional {2}NOT set in this shell /);
    expect(text).toContain("ARMADA_TICKET=DEMO-13");

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
      `\nnpm install -g @the-vibe-company/armada@${version}\narmada claim DEMO-13 --runtime conductor --handle "$CONDUCTOR_WORKSPACE_ID/$CONDUCTOR_SESSION_ID" --branch feature/demo-13-show-a-sign-in-page\n`,
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

  test("--prompt prints only the prompt and --json the whole brief with the chosen profile", async () => {
    const p = briefIo();
    expect(await run(["brief", "DEMO-13", "--prompt"], p.io)).toBe(0);
    expect(p.out().startsWith("# DEMO-13 — Show a sign-in page\n")).toBe(true);

    const j = briefIo();
    expect(await run(["brief", "DEMO-13", "--json", "--profile", "codex"], j.io)).toBe(0);
    const brief = JSON.parse(j.out());
    expect(brief.profile).toEqual({
      name: "codex",
      agent: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      fastMode: true,
    });
    expect(brief.prompt).toBe(p.out());
    expect(brief.environment.map((v: { name: string }) => v.name)).toEqual([
      "LINEAR_API_KEY",
      "ARMADA_TURSO_URL",
      "ARMADA_TURSO_TOKEN",
      "ARMADA_TICKET",
    ]);
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

  test("an unknown profile is a usage error, before any request", async () => {
    const b = briefIo();
    expect(await run(["brief", "DEMO-13", "--profile", "turbo"], b.io)).toBe(2);
    expect(b.err()).toBe('armada: no Conductor profile "turbo" (available: opus, codex)\n');
    expect(b.calls).toEqual([]);
  });
});
