import { afterEach, describe, expect, test } from "bun:test";
import { recordEvent, saveRuntimeHandle } from "@armada/core";
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
      "Claimed DEMO-7 for Conductor (ws-1/s-1).\nMoved to In Progress, assigned to Owner, labels planning and Conductor.\nNow: In Progress · phase planning · runtime Conductor · profile none\nhttps://linear.app/acme/issue/DEMO-7\n",
    );
    expect(w.err()).toBe("");

    w.reset();
    expect(await run(["report", "implementing", "--message=plan approved"], w.io)).toBe(0);
    expect(w.out()).toBe(
      "DEMO-7: planning → implementing.\nNow: In Progress · phase implementing · runtime Conductor · profile none\nhttps://linear.app/acme/issue/DEMO-7\nInbox: nothing waiting for you.\n",
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
    expect(w.err()).toEndWith(
      'Next: armada report <one of the phases above> --ticket DEMO-7 --message "<what you did>"\n',
    );

    w.linear.get("DEMO-7").labels = [{ id: "phase-shipping", name: "shipping", group: "Agent phase" }];
    w.reset();
    expect(await run(["report", "ready-to-merge", "--sha", HEAD.slice(0, 7), "--pr", "9"], w.io)).toBe(1);
    expect(w.err()).toBe(
      'armada: DEMO-7: hand-back refused:\n  - --sha must be the full 40-character commit SHA, got "0123456" (7 characters)\n  - check "test" is failure\nNext: fix the points above, then armada report ready-to-merge --ticket DEMO-7 --pr 9 --sha <head sha>; report shipping meanwhile if the work is not done\n',
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
    expect(w.err()).toBe("armada: --sha does not apply to claim\nNext: armada claim --help\n");
    w.reset();
    const claim = ["claim", "DEMO-7", "--runtime", "conductor", "--handle", "ws-1"];
    expect(await run([...claim, "--profile", "turbo"], w.io)).toBe(2);
    expect(w.err()).toBe('armada: no Conductor profile "turbo" (available: none)\nNext: armada claim --help\n');
    w.reset();
    expect(await run([...claim, "--reason", "why not"], w.io)).toBe(2);
    expect(w.err()).toContain("--reason goes with --profile");
  });

  test("a ready-to-merge report without a message option stays valid", async () => {
    const w = worker();
    w.linear.add("DEMO-7", {
      labels: [{ id: "phase-shipping", name: "shipping", group: "Agent phase" }],
    });
    w.io.fetch = async () =>
      Response.json(pullResponse({ number: 9, headSha: HEAD, checks: [{ name: "test", conclusion: "SUCCESS" }] }));
    expect(await run(["report", "ready-to-merge", "--pr", "9", "--sha", HEAD], w.io)).toBe(0);
    expect(w.linear.bodies).toEqual([`Agent status: ready-to-merge — PR #9, head ${HEAD}, CI green`]);
  });

  test("an explicitly blank message file is refused even for a hand-back", async () => {
    for (const message of ["", " \n\t"]) {
      const w = worker();
      const readFile = w.io.readFile;
      w.io.readFile = async (path) => (path === "report.md" ? message : readFile(path));
      expect(await run(["report", "ready-to-merge", "--message-file", "report.md"], w.io)).toBe(2);
      expect(w.err()).toContain("message file report.md is empty or whitespace-only");
      expect(w.linear.writes).toEqual([]);
    }
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

describe("armada ask, inbox and answer", () => {
  test.each<[string, Record<string, string>, string | null]>([
    [
      "explicit handle wins",
      { ARMADA_COORDINATOR_HANDLE: " ws-1/s-2 ", CONDUCTOR_WORKSPACE_ID: "ws-1", CONDUCTOR_SESSION_ID: "s-1" },
      "ws-1/s-2",
    ],
    ["complete runtime ids", { CONDUCTOR_WORKSPACE_ID: " ws-1 ", CONDUCTOR_SESSION_ID: " s-1 " }, "ws-1/s-1"],
    [
      "blank explicit handle falls back",
      { ARMADA_COORDINATOR_HANDLE: " ", CONDUCTOR_WORKSPACE_ID: "ws-1", CONDUCTOR_SESSION_ID: "s-1" },
      "ws-1/s-1",
    ],
    ["no identity", {}, null],
    ["workspace only", { CONDUCTOR_WORKSPACE_ID: "ws-1" }, null],
    ["session only", { CONDUCTOR_SESSION_ID: "s-1" }, null],
    ["blank session", { CONDUCTOR_WORKSPACE_ID: "ws-1", CONDUCTOR_SESSION_ID: " " }, null],
  ])("inbox identity: %s", async (_name, env, coordinator) => {
    const { url, db } = await tempTurso();
    const cli = worker({ ARMADA_TURSO_URL: url, ...env });
    const handles = ["ws-1/s-1", "ws-1/s-2"];
    for (const [index, handle] of handles.entries())
      await saveRuntimeHandle(db, {
        project: "widgets",
        ticket: `DEMO-${index + 1}`,
        runtime: "Conductor",
        handle,
        branch: null,
        at: new Date(NOW.getTime() - 30 * 60_000),
      });

    expect(await run(["inbox", "--json"], cli.io)).toBe(0);
    expect(JSON.parse(cli.out()).items.map((entry: { author: string }) => entry.author)).toEqual(
      handles.filter((handle) => handle !== coordinator),
    );
    expect(cli.err()).toBe("");
    const seen = await db.execute("SELECT handle FROM events WHERE kind = 'inbox'");
    expect(seen.rows.map((row) => row.handle)).toEqual([coordinator]);
  });

  test("a worker asks, the coordinator reads its inbox and records the answer, the worker resumes", async () => {
    const { url } = await tempTurso();
    const w = worker({ ARMADA_TURSO_URL: url });
    w.linear.add("DEMO-7");
    expect(await run(["claim", "DEMO-7", "--runtime", "conductor", "--handle", "ws-1/s-1"], w.io)).toBe(0);
    expect(await run(["report", "implementing", "--message", "plan approved"], w.io)).toBe(0);

    w.reset();
    expect(await run(["ask", "Which store keeps the sessions?", "--options", "SQLite | Redis"], w.io)).toBe(0);
    expect(w.out()).toBe(
      "DEMO-7: implementing → blocked.\nQuestion #1 is in the coordinator's inbox.\nStop here and wait for the answer in this session; then report the phase you resume.\nNow: In Progress · phase blocked · runtime Conductor · profile none\nhttps://linear.app/acme/issue/DEMO-7\nInbox: nothing waiting for you.\n",
    );

    w.reset();
    const coordinator = { ...w.io, env: { ARMADA_TURSO_URL: url }, gitBranch: () => "main" };
    expect(await run(["inbox"], coordinator)).toBe(0);
    expect(w.out()).toBe(
      [
        "Inbox of widgets (1), oldest first:",
        `  #1 question · DEMO-7 · from ws-1/s-1 · ${NOW.toISOString()}`,
        "    Which store keeps the sessions?",
        "",
        "    Options:",
        "    1. SQLite",
        "    2. Redis",
        'Deliver each answer in the worker\'s session with the runtime guide, then record it: armada answer <id> "<answer>".',
        "",
      ].join("\n"),
    );

    w.reset();
    expect(await run(["answer", "1", "SQLite, for the first slice."], { ...coordinator, env: w.io.env })).toBe(0);
    expect(w.out()).toBe(
      "Answer posted on DEMO-7 (blocked).\nInbox item #1 resolved.\nThe worker resumes once it reports its phase again.\nhttps://linear.app/acme/issue/DEMO-7\n",
    );

    w.reset();
    expect(await run(["inbox", "--json"], coordinator)).toBe(0);
    expect(JSON.parse(w.out()).items).toEqual([]);
    expect(await run(["report", "implementing", "--message", "resumed with SQLite"], w.io)).toBe(0);
    expect(w.linear.get("DEMO-7").labels.map((l) => l.name)).toEqual(["Conductor", "implementing"]);
  });

  test("usage mistakes exit 2", async () => {
    const w = worker();
    expect(await run(["ask"], w.io)).toBe(2);
    expect(w.err()).toContain("ask needs a question");
    w.reset();
    expect(await run(["inbox"], w.io)).toBe(2);
    expect(w.err()).toBe("armada: the inbox lives in Turso: set ARMADA_TURSO_URL\nNext: armada auth login\n");
    w.reset();
    expect(await run(["inbox", "--timeout", "30"], w.io)).toBe(2);
    expect(w.err()).toBe("armada: --timeout applies to --wait\nNext: armada inbox --help\n");
    w.reset();
    expect(await run(["answer", "3"], w.io)).toBe(2);
    expect(w.err()).toContain("answer needs the text");
  });
});
