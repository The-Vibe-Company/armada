import { describe, expect, test } from "bun:test";
import type { Fetch } from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import {
  ARMADA_URL,
  DEMO_TOML,
  FakeLinear,
  fakeArmada,
  fakeClock,
  NOW,
  pullResponse,
  recordedFetch,
} from "../../core/test/support.ts";
import { type Io, run } from "../src/cli.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const KEY = "armada_key_CANARY_fleet";
/** A terminal signed in to the fake Armada with an organization API key; no database variable anywhere. */
const SIGNED_IN = { ARMADA_API_URL: ARMADA_URL, ARMADA_API_KEY: KEY };

/**
 * A worker's terminal: the fake Armada behind `${ARMADA_URL}/api/cli/`, and
 * `rest` (GitHub by default) for every other address. No config home: the
 * real one is never read.
 */
function worker(
  env: Record<string, string> = {},
  o: { store?: ReturnType<typeof memoryFleet>; clock?: ReturnType<typeof fakeClock> } = {},
) {
  const store = o.store ?? memoryFleet();
  const armada = fakeArmada({ keys: { [KEY]: "fleet" }, store, ...(o.clock ? { clock: o.clock } : {}) });
  const linear = new FakeLinear();
  const out: string[] = [];
  const err: string[] = [];
  const net: { rest: Fetch } = {
    rest: async () =>
      Response.json(pullResponse({ number: 9, headSha: HEAD, checks: [{ name: "test", conclusion: "FAILURE" }] })),
  };
  const io: Io = {
    cwd: "/work/widgets",
    env: { LINEAR_API_KEY: "k", GITHUB_TOKEN: "t", ...env },
    readFile: async (path) => (path === "/work/widgets/armada.toml" ? DEMO_TOML : null),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ghToken: () => null,
    fetch: (url, init) => (url.startsWith(`${ARMADA_URL}/`) ? armada.fetch(url, init) : net.rest(url, init)),
    now: () => NOW,
    gitBranch: () => "feature/demo-7-do-the-thing",
    linearWriter: () => linear,
  };
  const reset = () => {
    out.length = 0;
    err.length = 0;
  };
  return { io, linear, armada, store, net, out: () => out.join(""), err: () => err.join(""), reset };
}

describe("armada claim, report and release", () => {
  test("a signed-in worker claims, reports on its branch and releases; Armada records every event", async () => {
    const w = worker(SIGNED_IN);
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
    expect(w.err()).toBe("");
    expect(w.store.events.map((e) => [e.project, e.ticket, e.kind])).toEqual([
      ["widgets", "DEMO-7", "claim"],
      ["widgets", "DEMO-7", "report"],
      ["widgets", "DEMO-7", "release"],
    ]);
    expect(await w.store.listProjects()).toMatchObject([
      { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "DEMO-1" },
    ]);
    // Every fleet call carried the API key, and the key never reached another address.
    const fleet = w.armada.calls.filter((c) => c.path.startsWith("fleet/"));
    expect(fleet.map((c) => [c.path, c.apiKey])).toEqual([
      ["fleet/claim", KEY],
      ["fleet/report", KEY],
      ["fleet/release", KEY],
    ]);
  });

  test("refusals exit 1 with the reason: invalid transition, short SHA, red CI", async () => {
    const w = worker();
    w.linear.add("DEMO-7");
    expect(await run(["claim", "DEMO-7", "--runtime", "conductor", "--handle", "ws-1"], w.io)).toBe(0);
    expect(w.err()).toBe(
      "armada: warning: not signed in to Armada (armada login); live activity is not recorded, Linear is\n",
    );
    expect(w.armada.calls).toEqual([]);

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
    w.net.rest = async () =>
      Response.json(pullResponse({ number: 9, headSha: HEAD, checks: [{ name: "test", conclusion: "SUCCESS" }] }));
    expect(await run(["report", "ready-to-merge", "--pr", "9", "--sha", HEAD], w.io)).toBe(0);
    expect(w.linear.bodies).toEqual([`Agent status: ready-to-merge — PR #9, head ${HEAD}, CI green`]);
  });

  test("--plan-file posts the plan under a one-line status, from a file or standard input", async () => {
    const plan = "Plan: parse the widget file\n\n1. Validate.\n2. Test.";
    const w = worker();
    w.linear.add("DEMO-7", { labels: [{ id: "phase-planning", name: "planning", group: "Agent phase" }] });
    const readFile = w.io.readFile;
    w.io.readFile = async (path) => (path === "plan.md" ? plan : readFile(path));
    expect(await run(["report", "implementing", "--plan-file", "plan.md"], w.io)).toBe(0);
    expect(w.linear.bodies.at(-1)).toBe(
      `Agent status: implementing — Plan: parse the widget file\n\n## Plan\n\n${plan}`,
    );

    w.io.readStdin = async () => plan;
    expect(await run(["report", "implementing", "--message", "plan posted", "--plan-file", "-"], w.io)).toBe(0);
    expect(w.linear.bodies.at(-1)).toBe(`Agent status: implementing — plan posted\n\n## Plan\n\n${plan}`);

    w.reset();
    const both = ["report", "implementing", "--message-file", "-", "--plan-file", "-"];
    expect(await run(both, w.io)).toBe(2);
    expect(w.err()).toContain("--message-file - and --plan-file - both read standard input");
    w.reset();
    expect(await run(["report", "implementing", "--plan", "x", "--plan-file", "plan.md"], w.io)).toBe(2);
    expect(w.err()).toContain("pass --plan or --plan-file, not both");
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

  test("an unreachable Armada only warns; Linear is still written", async () => {
    const w = worker(SIGNED_IN);
    w.io.fetch = async (url, init) => {
      if (url.startsWith(`${ARMADA_URL}/`)) throw new TypeError("fetch failed");
      return w.net.rest(url, init);
    };
    w.linear.add("DEMO-7");
    expect(await run(["claim", "DEMO-7", "--runtime", "conductor", "--handle", "ws-1"], w.io)).toBe(0);
    expect(w.linear.get("DEMO-7").labels.map((l) => l.name)).toEqual(["planning", "Conductor"]);
    expect(w.err()).toMatch(
      /^armada: warning: Armada: could not record the claim \(Armada \(armada\.example\.test\) unreachable: .+\); Linear is up to date\n$/,
    );
  });

  test("a revoked API key only warns; Linear is still written", async () => {
    const w = worker({ ...SIGNED_IN, ARMADA_API_KEY: "armada_key_CANARY_revoked" });
    w.linear.add("DEMO-7");
    expect(await run(["claim", "DEMO-7", "--runtime", "conductor", "--handle", "ws-1"], w.io)).toBe(0);
    expect(w.linear.get("DEMO-7").labels.map((l) => l.name)).toEqual(["planning", "Conductor"]);
    expect(w.err()).toBe(
      "armada: warning: Armada: could not record the claim (not signed in to Armada); Linear is up to date\n",
    );
    expect(w.err()).not.toContain("CANARY");
    expect(w.store.events).toEqual([]);
  });

  test("armada status measures silence from the last live event on Armada", async () => {
    const w = worker(SIGNED_IN);
    await w.store.recordEvent({
      project: "widgets",
      ticket: "DEMO-11",
      kind: "report",
      at: new Date("2026-03-04T09:55:00Z"),
    });
    w.net.rest = recordedFetch().fetch;
    expect(await run(["status", "--json"], w.io)).toBe(0);
    const lane = JSON.parse(w.out()).inFlight.find((t: { id: string }) => t.id === "DEMO-11");
    expect([lane.lastReport, lane.silent]).toEqual(["2026-03-04T09:55:00.000Z", false]);
    expect(w.armada.calls.map((c) => c.path)).toEqual(["fleet/events/latest", "fleet/launches"]);
  });

  test("armada status lists the workers launched that never claimed, under their own heading", async () => {
    const w = worker(SIGNED_IN);
    const launch = { project: "widgets", tokenUsedAt: null, handle: null, endedAt: null };
    w.store.launches.push(
      { ...launch, ticket: "DEMO-7", launchedAt: "2026-03-04T09:35:00.000Z" },
      { ...launch, ticket: "DEMO-8", launchedAt: "2026-03-04T09:40:00.000Z", tokenUsedAt: "2026-03-04T09:42:00.000Z" },
      // Within the 10 minutes `not_started_minutes` gives it.
      { ...launch, ticket: "DEMO-9", launchedAt: "2026-03-04T09:55:00.000Z" },
    );
    w.net.rest = recordedFetch().fetch;
    expect(await run(["status"], w.io)).toBe(0);
    expect(w.out()).toContain(
      [
        "Launched, not started (2)",
        "  DEMO-7   launched 25 min ago · launch token never used",
        "           ! check its session with the runtime guide's status section",
        "  DEMO-8   launched 20 min ago · signed in 18 min ago, no claim",
      ].join("\n"),
    );
    expect(w.out()).not.toContain("DEMO-9   launched");
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
    const cli = worker({ ...SIGNED_IN, ...env });
    const handles = ["ws-1/s-1", "ws-1/s-2"];
    for (const [index, handle] of handles.entries())
      await cli.store.saveRuntimeHandle({
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
    expect(cli.store.presence.get("widgets")).toEqual({ handle: coordinator, at: NOW.toISOString() });
  });

  test("a worker asks, the coordinator reads its inbox and records the answer, the worker resumes", async () => {
    const w = worker(SIGNED_IN);
    w.linear.add("DEMO-7");
    expect(await run(["claim", "DEMO-7", "--runtime", "conductor", "--handle", "ws-1/s-1"], w.io)).toBe(0);
    expect(await run(["report", "implementing", "--message", "plan approved"], w.io)).toBe(0);

    w.reset();
    expect(await run(["ask", "Which store keeps the sessions?", "--options", "SQLite | Redis"], w.io)).toBe(0);
    expect(w.out()).toBe(
      "DEMO-7: implementing → blocked.\nQuestion #1 is in the coordinator's inbox.\nStop here and wait for the answer in this session; then report the phase you resume.\nNow: In Progress · phase blocked · runtime Conductor · profile none\nhttps://linear.app/acme/issue/DEMO-7\nInbox: nothing waiting for you.\n",
    );

    w.reset();
    // The coordinator's terminal: signed in, no Linear key (the inbox needs none).
    const coordinator = { ...w.io, env: SIGNED_IN, gitBranch: () => "main" };
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
        "1 worker in flight (DEMO-7) — act on the items above, then keep watching: armada watch",
        "",
      ].join("\n"),
    );

    w.reset();
    expect(await run(["answer", "1", "SQLite, for the first slice."], { ...coordinator, env: w.io.env })).toBe(0);
    expect(w.out()).toBe(
      "Answer posted on DEMO-7 (blocked).\nInbox item #1 resolved.\nThe worker resumes once it reports its phase again.\nhttps://linear.app/acme/issue/DEMO-7\n",
    );
    expect(w.store.items[0]).toMatchObject({ kind: "question", resolution: "SQLite, for the first slice." });

    w.reset();
    expect(await run(["inbox", "--json"], coordinator)).toBe(0);
    expect(JSON.parse(w.out()).items).toEqual([]);
    expect(await run(["report", "implementing", "--message", "resumed with SQLite"], w.io)).toBe(0);
    expect(w.linear.get("DEMO-7").labels.map((l) => l.name)).toEqual(["Conductor", "implementing"]);
  });

  test("inbox --wait asks Armada every 15 s, sending the last read's etag, until a new item or its timeout", async () => {
    const clock = fakeClock();
    const w = worker(SIGNED_IN, { clock });
    w.io.now = clock.now;
    w.io.sleep = clock.sleep;
    expect(await run(["inbox", "--wait", "--timeout", "60"], w.io)).toBe(0);
    expect(w.out()).toBe(
      "Inbox of widgets: nothing waits for you.\nNo new item within 60 s.\nNo worker in flight and nothing open — nothing to watch.\n",
    );
    // One read, then an ask every 15 s with the etag of that read: Armada answers 304 each time.
    const etags = w.armada.calls.map((c) => (c.body as { input: { etag: string | null } }).input.etag);
    expect([etags.length, etags[0], new Set(etags.slice(1)).size]).toEqual([5, null, 1]);
    expect(clock.now().toISOString()).toBe(new Date(NOW.getTime() + 60_000).toISOString());

    // A question asked while the coordinator waits ends the wait, marked new.
    const store = memoryFleet();
    const w2 = worker(SIGNED_IN, { store, clock: fakeClock() });
    w2.io.sleep = async () => {
      if (!store.items.some((i) => i.ticket === "DEMO-9"))
        await store.addInboxItem({
          project: "widgets",
          ticket: "DEMO-9",
          kind: "question",
          recipient: "coordinator",
          author: "ws-9/s-9",
          body: "Which queue?",
          at: NOW,
        });
    };
    expect(await run(["inbox", "--wait", "--json"], w2.io)).toBe(0);
    const report = JSON.parse(w2.out());
    expect(report.items.map((e: { ticket: string; new: boolean }) => [e.ticket, e.new])).toEqual([["DEMO-9", true]]);
    expect(report.wait).toEqual({ timeoutSeconds: 300, timedOut: false });
  });

  test("usage mistakes exit 2; the inbox needs a sign-in", async () => {
    const w = worker();
    expect(await run(["ask"], w.io)).toBe(2);
    expect(w.err()).toContain("ask needs a question");
    w.reset();
    expect(await run(["inbox"], w.io)).toBe(2);
    expect(w.err()).toBe(
      "armada: not signed in to Armada (armada.thevibecompany.co). A person signs in with `armada login`; a headless coordinator sets ARMADA_API_KEY to an organization API key\nNext: armada login\n",
    );
    expect(w.armada.calls).toEqual([]);
    w.reset();
    expect(await run(["inbox", "--timeout", "30"], w.io)).toBe(2);
    expect(w.err()).toBe("armada: --timeout applies to --wait\nNext: armada inbox --help\n");
    w.reset();
    expect(await run(["answer", "3"], w.io)).toBe(2);
    expect(w.err()).toContain("answer needs the text");
  });
});
