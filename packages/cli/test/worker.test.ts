import { afterEach, describe, expect, test } from "bun:test";
import { recordEvent } from "@armada/core";
import {
  closeTempTurso,
  DEMO_TOML,
  FakeLinear,
  NOW,
  pullResponse,
  recordedFetch,
  tempTurso,
} from "../../core/test/support.ts";
import { type Io, run } from "../src/cli.ts";

afterEach(closeTempTurso);

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function worker(env: Record<string, string> = {}) {
  const linear = new FakeLinear();
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: "/work/widgets",
    env: { LINEAR_API_KEY: "k", GITHUB_TOKEN: "t", ...env },
    readFile: async (path) => (path === "/work/widgets/armada.toml" ? DEMO_TOML : null),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ghToken: () => null,
    fetch: async () =>
      Response.json(pullResponse({ number: 9, headSha: HEAD, checks: [{ name: "test", conclusion: "FAILURE" }] })),
    now: () => NOW,
    gitBranch: () => "feature/demo-7-do-the-thing",
    linearWriter: () => linear,
  };
  const reset = () => {
    out.length = 0;
    err.length = 0;
  };
  return { io, linear, out: () => out.join(""), err: () => err.join(""), reset };
}

describe("armada claim, report and release", () => {
  test("a worker claims, reports on its branch and releases; Turso gets every event", async () => {
    const { url, db } = await tempTurso();
    const w = worker({ ARMADA_TURSO_URL: url });
    w.linear.add("DEMO-7");
    expect(await run(["claim", "demo-7", "--runtime", "conductor", "--handle", "ws-1/s-1"], w.io)).toBe(0);
    expect(w.out()).toBe(
      "Claimed DEMO-7 for Conductor (ws-1/s-1).\nMoved to In Progress, assigned to Owner, labels planning and Conductor.\nhttps://linear.app/acme/issue/DEMO-7\n",
    );
    expect(w.err()).toBe("");

    w.reset();
    expect(await run(["report", "implementing", "--message=plan approved"], w.io)).toBe(0);
    expect(w.out()).toBe(
      "DEMO-7: planning → implementing.\nhttps://linear.app/acme/issue/DEMO-7\nInbox: nothing waiting for you.\n",
    );

    w.reset();
    expect(await run(["release", "--reason", "wrong ticket"], w.io)).toBe(0);
    const kinds = await db.execute("SELECT kind FROM events WHERE ticket = 'DEMO-7' ORDER BY id");
    expect(kinds.rows.map((r) => r.kind)).toEqual(["claim", "report", "release"]);
  });

  test("refusals exit 1 with the reason: invalid transition, short SHA, red CI", async () => {
    const w = worker();
    w.linear.add("DEMO-7");
    expect(await run(["claim", "DEMO-7", "--runtime", "conductor", "--handle", "ws-1"], w.io)).toBe(0);
    expect(w.err()).toBe(
      "armada: warning: Turso is not configured (ARMADA_TURSO_URL); live activity is not recorded\n",
    );

    w.reset();
    expect(await run(["report", "ready-to-merge", "--sha", HEAD, "--pr", "9"], w.io)).toBe(1);
    expect(w.err()).toContain("cannot go from planning to ready-to-merge");

    w.linear.get("DEMO-7").labels = [{ id: "phase-shipping", name: "shipping", group: "Agent phase" }];
    w.reset();
    expect(await run(["report", "ready-to-merge", "--sha", HEAD.slice(0, 7), "--pr", "9"], w.io)).toBe(1);
    expect(w.err()).toBe(
      'armada: DEMO-7: hand-back refused:\n  - --sha must be the full 40-character commit SHA, got "0123456" (7 characters)\n  - check "test" is failure\n',
    );
  });

  test("usage mistakes exit 2", async () => {
    const w = worker();
    expect(await run(["report", "implementing"], w.io)).toBe(2);
    expect(w.err()).toContain("--message is required");
    w.reset();
    expect(await run(["report", "coding", "--message", "x"], w.io)).toBe(2);
    expect(w.err()).toContain("report needs a phase: planning, awaiting-approval");
    w.reset();
    expect(await run(["claim", "DEMO-7", "--sha", HEAD], w.io)).toBe(2);
    expect(w.err()).toBe("armada: --sha does not apply to claim\n");
  });

  test("an unreachable Turso only warns; Linear is still written", async () => {
    const w = worker({ ARMADA_TURSO_URL: "file:/nonexistent-armada-dir/sub/armada.db" });
    w.linear.add("DEMO-7");
    expect(await run(["claim", "DEMO-7", "--runtime", "conductor", "--handle", "ws-1"], w.io)).toBe(0);
    expect(w.linear.get("DEMO-7").labels.map((l) => l.name)).toEqual(["planning", "Conductor"]);
    expect(w.err()).toMatch(/^armada: warning: Turso unavailable \(.+\); live activity is not recorded, Linear is\n$/);
  });

  test("armada status measures silence from the last Turso event", async () => {
    const { url, db } = await tempTurso();
    await recordEvent(db, {
      project: "widgets",
      ticket: "DEMO-11",
      kind: "report",
      at: new Date("2026-03-04T09:55:00Z"),
    });
    const w = worker({ ARMADA_TURSO_URL: url });
    w.io.fetch = recordedFetch().fetch;
    expect(await run(["status", "--json"], w.io)).toBe(0);
    const lane = JSON.parse(w.out()).inFlight.find((t: { id: string }) => t.id === "DEMO-11");
    expect([lane.lastReport, lane.silent]).toEqual(["2026-03-04T09:55:00.000Z", false]);
  });
});
