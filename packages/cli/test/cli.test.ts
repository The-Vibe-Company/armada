import { describe, expect, test } from "bun:test";
import { DEMO_TOML, NOW, recordedFetch } from "../../core/test/support.ts";
import { type Io, run } from "../src/cli.ts";

function fakeIo(
  files: Record<string, string>,
  env: Record<string, string> = { LINEAR_API_KEY: "k", GITHUB_TOKEN: "t" },
) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: "/work/widgets/packages/app",
    env,
    readFile: async (path) => files[path] ?? null,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ghToken: () => null,
    fetch: recordedFetch().fetch,
    now: () => NOW,
  };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

describe("armada status", () => {
  test("--json prints the report found from the nearest armada.toml", async () => {
    const { io, out } = fakeIo({ "/work/widgets/armada.toml": DEMO_TOML });
    expect(await run(["status", "--json"], io)).toBe(0);
    const report = JSON.parse(out());
    expect(report.project).toEqual({ name: "Widgets", slug: "widgets", repository: "acme/widgets" });
    expect(report.inFlight.map((t: { id: string }) => t.id)).toEqual(["DEMO-18", "DEMO-16", "DEMO-11"]);
    expect(report.frontier.map((t: { id: string }) => t.id)).toEqual(["DEMO-13", "DEMO-15"]);
  });

  test("prints a readable summary by default", async () => {
    const { io, out } = fakeIo({ "/work/widgets/armada.toml": DEMO_TOML });
    expect(await run(["status"], io)).toBe(0);
    expect(out()).toBe(`Widgets · DEMO-1 Widgets: sign in and share lists
Read 2026-03-04 10:00 UTC · Linear DEMO-1 · GitHub acme/widgets

In flight (3)
  DEMO-18  ready-to-merge          Codex · Grace Worker · updated 15 min ago
           Expire idle sessions [Spec 1]
           “PR #9, head 9f1c2d3e4b5a69788796a5b4c3d2e1f00a1b2c3d, CI green”
           PR #9 · CI success · mergeable
  DEMO-16  shipping (status-line)  unassigned · updated 15 min ago
           Reset a forgotten password [Spec 1]
           “PR open, fixing CI”
           PR #8 · CI failure · mergeable
           ! ci-failing, no-assignee, no-phase-label
  DEMO-11  implementing            Claude Code · Ada Worker · updated 10 min ago
           Send a sign-in link by email [Spec 1]
           “plan approved, writing the email sender”
           PR #7 · CI pending · mergeability unknown

Ready to start (1)
  DEMO-13  Show a sign-in page  (Spec 1 · unlocks 1 · critical path)

Unblocked but not marked ready (1)
  DEMO-15  Rate-limit sign-in attempts

Pull requests waiting (4)
  #7       DEMO-11 implementing · CI pending · mergeability unknown
           feat(auth): send a sign-in link
  #8       DEMO-16 shipping · CI failure · mergeable
           feat(auth): reset a forgotten password
           ! failing: test
  #9       DEMO-18 ready-to-merge · CI success · mergeable
           feat(auth): expire idle sessions
  #10      no ticket · draft · no CI · mergeable
           chore: bump dependencies
`);
  });

  test("a missing armada.toml or a missing key is a configuration error naming what is missing", async () => {
    const missing = fakeIo({});
    expect(await run(["status"], missing.io)).toBe(2);
    expect(missing.err()).toContain("no armada.toml found in /work/widgets/packages/app or any parent directory");

    const partial = fakeIo({ "/work/widgets/armada.toml": DEMO_TOML.replace('slug = "widgets"', "") });
    expect(await run(["status"], partial.io)).toBe(2);
    expect(partial.err()).toContain('missing required key "project.slug"');
  });

  test("LINEAR_API_KEY is required", async () => {
    const { io, err } = fakeIo({ "/work/widgets/armada.toml": DEMO_TOML }, {});
    expect(await run(["status"], io)).toBe(2);
    expect(err()).toContain("LINEAR_API_KEY is not set");
  });
});
