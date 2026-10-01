import { afterEach, describe, expect, test } from "bun:test";
import {
  type ArmadaConfig,
  configTemplate,
  type Issue,
  type ProjectInput,
  parseConfig,
  type StatusSources,
} from "@armada/core/read";
import { issue } from "../../core/test/support.ts";
import type { Database } from "../lib/db.ts";
import {
  type LoadOptions,
  loadOverview as load,
  loadAgentActivity,
  loadProject,
  newCache,
  type Scope,
  type Sources,
} from "../lib/fleet-data.ts";
import {
  addInboxItem,
  assignUnownedProjects,
  fleetStore,
  liveStore,
  recordEvent,
  resolveInboxItem,
  saveRuntimeHandle,
  upsertProject,
} from "../lib/fleet-store.ts";
import { answerJson, answerOverview } from "../lib/live-http.ts";
import { submitAnswer as answer, submitLaunch as launchReq } from "../lib/requests.ts";
import { markRepository } from "../lib/snapshots.ts";
import { addOrganizations, tempDatabase } from "./support.ts";

const open: Database[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.end().catch(() => {})));
});

/** A fresh app database with the organizations these tests name. */
async function tempDb(): Promise<Database> {
  const db = await tempDatabase();
  open.push(db);
  await addOrganizations(db, "org-home", "org-other");
  return db;
}

/** A member of the deployment's first organization, the one that owns every project in these tests. */
const HOME: Scope = { organization: "org-home", home: "org-home" };
const loadOverview = (opts: LoadOptions, scope: Scope = HOME) => load(opts, scope);
const submitAnswer = (opts: LoadOptions, form: Parameters<typeof answer>[2], scope: Scope = HOME) =>
  answer(opts, scope, form);
const submitLaunch = (opts: LoadOptions, form: Parameters<typeof launchReq>[2], scope: Scope = HOME) =>
  launchReq(opts, scope, form);

const WIDGETS: ProjectInput = { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "WID-1" };
const T0 = Date.parse("2026-03-04T10:00:00Z");

function snapshot(config: ArmadaConfig, at: number, tickets: Issue[]): StatusSources {
  const fetchedAt = new Date(at).toISOString();
  return {
    program: {
      rootId: config.tracker.programRoot,
      fetchedAt,
      issues: [issue("WID-1"), ...tickets.map((t) => ({ ...t, parentId: "WID-1" }))],
      comments: [],
      warnings: [],
    },
    forge: { repo: config.github.repository, fetchedAt, prs: [], warnings: [] },
    forgeError: null,
  };
}

/** One project with one worker implementing WID-2 and two tickets ready to start (WID-3, an api one, and WID-4); `reads` counts the Linear and GitHub reads. */
function world(db: Database | null, over: Partial<Sources> = {}) {
  let clock = T0;
  const reads = { snapshots: 0 };
  const sources: Sources = {
    live: async () => (db ? liveStore(db) : null),
    database: async () => db,
    fallbackProjects: () => [{ repository: WIDGETS.repository }],
    readConfig: async () => ({ config: parseConfig(configTemplate(WIDGETS)), warning: null }),
    readSnapshot: async (config) => {
      reads.snapshots++;
      const worker = issue("WID-2", {
        title: "Export a report",
        statusType: "started",
        agentPhase: "implementing",
        assignee: "Worker",
        updatedAt: new Date(clock).toISOString(),
      });
      const ready = ["WID-3", "WID-4"].map((id) =>
        issue(id, { title: `Ready ${id}`, labels: id === "WID-3" ? ["ready-for-agent", "api"] : ["ready-for-agent"] }),
      );
      return snapshot(config, clock, [worker, ...ready]);
    },
    ...over,
  };
  const background: Promise<unknown>[] = [];
  const opts: LoadOptions = {
    sources,
    cache: newCache(),
    now: () => new Date(clock),
    snapshotMs: 60_000,
    background: (work) => background.push(work),
  };
  /** Runs the refreshes the reads started, as `after()` does once the response is sent. */
  const settle = async () => {
    while (background.length) await Promise.all(background.splice(0));
  };
  return {
    opts,
    reads,
    background,
    settle,
    /** A first view, which starts the first reading, then the reading done. */
    warm: async (scope: Scope = HOME) => {
      await load(opts, scope);
      await settle();
    },
    advance: (ms: number) => {
      clock += ms;
    },
    at: (ms: number) => new Date(T0 + ms),
  };
}

describe("live Fleet reading", () => {
  test("the overview poll includes dashboard facts from Postgres and its ETag tracks those facts", async () => {
    const db = await tempDb();
    await upsertProject(db, { ...WIDGETS, owner: "Synthetic Owner" });
    const w = world(db);
    const readSnapshot = w.opts.sources.readSnapshot;
    w.opts.sources.readSnapshot = async (config) => {
      const sources = await readSnapshot(config);
      if (sources.forge)
        sources.forge.prs.push({
          number: 11,
          url: "https://github.com/acme/widgets/pull/11",
          title: "Export a report",
          repo: WIDGETS.repository,
          state: "open",
          draft: false,
          ci: "failure",
          mergeable: "MERGEABLE",
          mergeability: "behind",
          additions: 8,
          deletions: 3,
          files: [{ path: "src/export.ts", additions: 8, deletions: 3 }],
          filesComplete: true,
          checksComplete: true,
          checks: [{ name: "unit", state: "failure" }],
        });
      return sources;
    };
    const store = fleetStore(db);
    await store.saveRuntimeHandle({
      project: "widgets",
      ticket: "WID-2",
      runtime: "Codex",
      handle: "ws/session",
      branch: null,
      at: w.at(0),
    });
    await store.saveWorkerProfile({
      project: "widgets",
      ticket: "WID-2",
      at: w.at(0),
      profile: {
        name: "fast",
        agent: "codex",
        model: "synthetic-model",
        effort: "high",
        fastMode: false,
        routed: "fast",
        reason: null,
        why: "default",
      },
    });
    const facts = { harness: "conductor-cloud" as const, handle: "ws/coordinator", model: null, cliVersion: "0.2.4" };
    await store.recordCoordinatorSeen({ project: "widgets", facts, inboxRead: false, at: w.at(0) });
    await recordEvent(db, {
      project: "widgets",
      ticket: "WID-2",
      kind: "report",
      phase: "implementing",
      message: "Tests added",
      at: w.at(1_000),
    });
    w.advance(2_000);
    const cold = await loadOverview(w.opts);
    expect(cold.projects[0]).toMatchObject({ reading: true, owner: "Synthetic Owner", coordinator: facts });
    expect(cold.sessions).toHaveLength(1);
    expect(w.reads.snapshots).toBe(0);
    await w.settle();
    const initial = await loadOverview(w.opts);
    const request = new Request("https://armada.example.test/api/fleet");
    const response = answerOverview(request, initial);
    const tag = response.headers.get("etag") ?? "";
    const json = await response.json();
    expect(json.projects[0]).toMatchObject({
      owner: "Synthetic Owner",
      progress: { done: 0, total: 3 },
      health: "blocked",
      coordinator: { ...facts, inboxSeenAt: null, startedAt: w.at(0).toISOString(), inboxReads: [] },
      pullRequests: [
        {
          number: 11,
          additions: 8,
          deletions: 3,
          failingChecks: ["unit"],
          mergeability: "behind",
          files: [{ path: "src/export.ts", additions: 8, deletions: 3 }],
        },
      ],
    });
    expect(json.rows[0].session).toMatchObject({
      profile: "fast",
      model: "synthetic-model",
      claimedAt: w.at(0).toISOString(),
      lastReport: { message: "Tests added" },
    });
    expect(json.sessions).toHaveLength(1);
    const conditional = new Request(request, { headers: { "if-none-match": tag } });
    w.advance(1_000);
    expect(answerOverview(conditional, await loadOverview(w.opts)).status).toBe(304);
    const forbidSource = async (): Promise<never> => {
      throw new Error("poll read an external source");
    };
    w.opts.sources.readConfig = forbidSource;
    w.opts.sources.readSnapshot = forbidSource;
    w.opts.sources.readChanges = forbidSource;
    await store.recordCoordinatorSeen({ project: "widgets", facts, inboxRead: true, at: w.at(3_000) });
    await store.addRequest({
      project: "widgets",
      ticket: "WID-2",
      kind: "merge-request",
      author: "Synthetic Owner",
      body: "Please merge PR #11",
      question: null,
      profile: null,
      pr: 11,
      at: w.at(3_000),
    });
    const changed = answerOverview(conditional, await loadOverview(w.opts));
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(tag);
    const updated = await changed.json();
    expect(updated.projects[0].coordinator.inboxReads).toMatchObject([{ at: w.at(3_000).toISOString() }]);
    expect(updated.projects[0].requests).toMatchObject([{ kind: "merge-request", request: { pr: 11 } }]);
    expect(w.reads.snapshots).toBe(1);
  });

  test("a report recorded after the Linear read shows on the next poll without reading Linear again", async () => {
    const db = await tempDb();
    await upsertProject(db, WIDGETS);
    const w = world(db);

    // The first view never waits for Linear and GitHub: their first reading runs after it.
    const cold = await loadOverview(w.opts);
    expect(cold.projects.map((p) => [p.slug, p.reading, p.error])).toEqual([["widgets", true, null]]);
    expect(cold.rows).toEqual([]);
    await w.settle();
    const first = await loadOverview(w.opts);
    expect(first.rows.map((r) => [r.id, r.phase, r.phaseSource])).toEqual([["WID-2", "implementing", "label"]]);

    await recordEvent(db, {
      project: "widgets",
      ticket: "WID-2",
      kind: "report",
      phase: "shipping",
      message: "PR open",
      at: w.at(2_000),
    });
    w.advance(5_000);
    const next = await loadOverview(w.opts);
    expect(next.rows.map((r) => [r.id, r.phase, r.phaseSource, r.statusLine?.summary])).toEqual([
      ["WID-2", "shipping", "live", "PR open"],
    ]);
    expect(w.reads.snapshots).toBe(1);
  });

  test("each row's timeline draws Armada's events of the last hours from Postgres", async () => {
    const db = await tempDb();
    await upsertProject(db, WIDGETS);
    const w = world(db);
    await w.warm();
    const report = (phase: string, ms: number) =>
      recordEvent(db, { project: "widgets", ticket: "WID-2", kind: "report", phase, message: phase, at: w.at(ms) });
    // Older than the timeline's span: not read on a poll.
    await report("planning", -10 * 3_600_000);
    await report("planning", -3_600_000);
    await report("implementing", -1_800_000);
    const o = await loadOverview(w.opts);
    const timeline = o.rows[0]?.timeline;
    expect(timeline?.reports).toEqual([w.at(-3_600_000).toISOString(), w.at(-1_800_000).toISOString()]);
    expect(timeline?.phases.map((s) => [s.phase, s.from])).toEqual([
      ["planning", w.at(-3_600_000).toISOString()],
      ["implementing", w.at(-1_800_000).toISOString()],
    ]);
  });

  test("with the database unreachable the view falls back to Linear and GitHub and says so", async () => {
    const db = await tempDb();
    await upsertProject(db, WIDGETS);
    const w = world(db);
    await w.warm();

    await db.end();
    const fallback = await loadOverview(w.opts);
    expect(fallback.live.state).toBe("unreachable");
    expect(fallback.rows.map((r) => r.id)).toEqual(["WID-2"]);
    expect(fallback.projects.map((p) => [p.slug, p.coordinator.state])).toEqual([["widgets", "unknown"]]);

    // A fresh server with no registry reading yet shows the repositories it was given.
    const cold = world(null, {
      live: async () => {
        throw new Error("connection refused");
      },
    });
    await cold.warm();
    const coldView = await loadOverview(cold.opts);
    expect(coldView.projects.map((p) => [p.slug, p.repository, p.inFlight])).toEqual([["widgets", "acme/widgets", 1]]);
  });

  test("a stale reading is served while it refreshes; a failed refresh keeps it, warns and waits a period", async () => {
    let fail = false;
    let attempts = 0;
    const w = world(null);
    const read = w.opts.sources.readSnapshot;
    w.opts.sources.readSnapshot = async (config) => {
      attempts++;
      if (fail) throw new Error("Linear: HTTP 503");
      return read(config);
    };
    await w.warm();

    fail = true;
    w.advance(61_000);
    const stale = await loadOverview(w.opts);
    expect(stale.rows.map((r) => r.id)).toEqual(["WID-2"]);
    expect(w.background).toHaveLength(1);
    await Promise.all(w.background);

    const after = await loadOverview(w.opts);
    expect(after.rows.map((r) => r.id)).toEqual(["WID-2"]);
    expect(after.projects[0]?.warnings).toEqual([
      "Linear or GitHub could not be read again (Linear: HTTP 503); showing the last reading",
    ]);
    // The next polls within the period do not read Linear again.
    w.advance(5_000);
    await loadOverview(w.opts);
    expect(attempts).toBe(2);
  });
});

describe("speed: a page reads Postgres only (THE-853)", () => {
  test("no page or poll ever waits for Linear or GitHub, cold, stale or marked by a webhook", async () => {
    const db = await tempDb();
    await upsertProject(db, WIDGETS);
    const w = world(db);
    await w.warm();
    // From now on Linear and GitHub never answer, and any direct call fails the test.
    const never = new Promise<never>(() => {});
    w.opts.sources.readConfig = () => never;
    w.opts.sources.readSnapshot = () => never;
    w.opts.sources.readChanges = () => never;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("a page request called the network");
    }) as unknown as typeof fetch;
    try {
      w.advance(61_000);
      const stale = await loadOverview(w.opts);
      expect(stale.rows.map((r) => r.id)).toEqual(["WID-2"]);
      expect(w.background).toHaveLength(1);
      expect((await loadProject(w.opts, "widgets", HOME))?.report.inFlight.map((t) => t.id)).toEqual(["WID-2"]);
      expect((await loadAgentActivity(w.opts, HOME, "widgets", "WID-2"))?.live).toBe(true);
      expect(await markRepository(db, "acme/widgets")).toEqual(["widgets"]);
      expect((await loadOverview(w.opts)).rows.map((r) => r.id)).toEqual(["WID-2"]);

      // Another server, cold: the reading comes from Postgres, not from Linear.
      const other = world(db);
      other.opts.sources.readSnapshot = () => never;
      const cold = await loadOverview(other.opts);
      expect(cold.rows.map((r) => r.id)).toEqual(["WID-2"]);
      expect(other.reads.snapshots).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("one refresh per project at a time across servers; the others serve the reading they have", async () => {
    const db = await tempDb();
    await upsertProject(db, WIDGETS);
    const a = world(db);
    const b = world(db);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = a.opts.sources.readSnapshot;
    let reads = 0;
    for (const w of [a, b])
      w.opts.sources.readSnapshot = async (config) => {
        reads++;
        await gate;
        return read(config);
      };
    const views = await Promise.all([loadOverview(a.opts), loadOverview(b.opts)]);
    expect(views.map((v) => v.projects[0]?.reading)).toEqual([true, true]);
    // Whichever started second finds the lease taken, or the reading already written.
    await Promise.all([loadOverview(a.opts), loadOverview(b.opts)]);
    release();
    await Promise.all([a.settle(), b.settle()]);
    expect(reads).toBe(1);
    expect((await loadOverview(b.opts)).rows.map((r) => r.id)).toEqual(["WID-2"]);
  });

  test("a stale reading is brought up to date with Linear's changes and the pull requests, and read whole every 30 minutes", async () => {
    const db = await tempDb();
    await upsertProject(db, WIDGETS);
    const w = world(db);
    const asks: unknown[] = [];
    w.opts.sources.readChanges = async (_config, previous, ask) => {
      asks.push(ask);
      return previous;
    };
    await w.warm();
    expect(w.reads.snapshots).toBe(1);

    w.advance(61_000);
    await w.warm();
    expect(asks).toEqual([{ linearSince: new Date(T0 - 120_000).toISOString(), touched: [], forge: true }]);
    expect(w.reads.snapshots).toBe(1);

    w.advance(30 * 60_000);
    await w.warm();
    expect(w.reads.snapshots).toBe(2);
    expect(asks).toHaveLength(1);
  });
});

describe("an agent's activity (THE-869)", () => {
  test("merges the ticket's Linear comments with its events and inbox, for its organization only, with an ETag", async () => {
    const db = await tempDb();
    await upsertProject(db, WIDGETS);
    await assignUnownedProjects(db, "org-home");
    const w = world(db, {
      readSnapshot: async (config) => {
        const s = snapshot(config, T0, [issue("WID-2", { statusType: "started", agentPhase: "implementing" })]);
        s.program.comments = [
          {
            id: "c1",
            issueId: "WID-2",
            author: "Worker",
            createdAt: new Date(T0 - 60 * 60_000).toISOString(),
            excerpt: "",
            status: null,
            claim: {
              runtime: "Conductor",
              session: "ws/2",
              branch: "feature/wid-2",
              startedAt: null,
              at: new Date(T0 - 60 * 60_000).toISOString(),
              author: "Worker",
            },
          },
          // Another ticket's comment never shows.
          {
            id: "c2",
            issueId: "WID-3",
            author: "X",
            createdAt: s.program.fetchedAt,
            excerpt: "elsewhere",
            status: null,
            claim: null,
          },
        ];
        return s;
      },
    });
    const base = { project: "widgets", ticket: "WID-2" };
    await recordEvent(db, { ...base, kind: "claim", runtime: "Conductor", handle: "ws/2", at: w.at(-60 * 60_000) });
    await recordEvent(db, {
      ...base,
      kind: "report",
      phase: "implementing",
      message: "parser",
      at: w.at(-30 * 60_000),
    });
    await addInboxItem(db, {
      ...base,
      kind: "question",
      recipient: "coordinator",
      author: "ws/2",
      body: "Which table?",
      at: w.at(-20 * 60_000),
    });
    await resolveInboxItem(db, { project: "widgets", id: 1, resolution: "orders", at: w.at(-10 * 60_000) });
    await w.warm();

    const activity = await loadAgentActivity(w.opts, HOME, "widgets", "WID-2");
    expect(activity?.live).toBe(true);
    expect(activity?.entries.map((e) => e.kind)).toEqual(["answer", "question", "phase", "branch", "claim"]);
    expect(activity?.entries.find((e) => e.kind === "claim")).toMatchObject({
      handle: "ws/2",
      branch: "feature/wid-2",
    });
    expect(activity?.entries[0]?.text).toBe("orders");

    expect(
      await loadAgentActivity(w.opts, { organization: "org-other", home: "org-home" }, "widgets", "WID-2"),
    ).toBeNull();
    expect(await loadAgentActivity(w.opts, HOME, "nope", "WID-2")).toBeNull();

    const first = answerJson(new Request("http://x/api/fleet/activity"), activity);
    const tag = first.headers.get("etag") ?? "";
    const again = answerJson(
      new Request("http://x/api/fleet/activity", { headers: { "If-None-Match": tag } }),
      activity,
    );
    expect(again.status).toBe(304);
  });
});

describe("organizations", () => {
  test("each organization sees only its projects; projects registered without one go to the first organization", async () => {
    const db = await tempDb();
    await upsertProject(db, WIDGETS);
    const other: Scope = { organization: "org-other", home: "org-home" };
    const w = world(db);

    // Before the first organization exists, nobody is shown an unassigned project.
    expect((await loadOverview(w.opts, { organization: "org-home", home: null })).projects).toEqual([]);
    expect((await loadOverview(w.opts, other)).projects).toEqual([]);
    expect((await loadOverview(w.opts)).projects.map((p) => p.slug)).toEqual(["widgets"]);
    // The move is recorded: it no longer depends on which organization is first.
    expect((await loadOverview(w.opts, { organization: "org-home", home: "org-other" })).projects).toHaveLength(1);

    // A request names a project the viewer cannot see: refused as unknown, nothing written.
    await w.settle();
    const launch = { project: "widgets", ticket: "WID-3", profile: null, author: "Ada <ada@example.test>" };
    expect(await submitLaunch(w.opts, launch, other)).toMatchObject({ ok: false, code: "unknown-project" });
    expect(await submitLaunch(w.opts, launch)).toMatchObject({ ok: true });

    // ARMADA_REPOSITORIES, shown while the registry was never read, belongs to the first organization too.
    const cold = world(null);
    await cold.warm();
    expect((await loadOverview(cold.opts)).projects.map((p) => p.slug)).toEqual(["widgets"]);
    expect((await loadOverview(cold.opts, other)).projects).toEqual([]);
  });
});

describe("organizations: a repository naming another project", () => {
  test("shows none of that project's live data to the other organization", async () => {
    const db = await tempDb();
    await upsertProject(db, WIDGETS);
    await assignUnownedProjects(db, "org-home");
    // Registered by another organization, but its armada.toml says "widgets" (every config in this world does).
    await upsertProject(db, { slug: "impostor", name: "Impostor", repository: "acme/impostor", programRoot: "IMP-1" });
    await assignUnownedProjects(db, "org-other");
    await addInboxItem(db, {
      project: "widgets",
      ticket: "WID-2",
      kind: "question",
      recipient: "coordinator",
      author: "ws/2",
      body: "Which table?",
      at: new Date(T0),
    });
    const w = world(db);
    await w.warm();
    await w.warm({ organization: "org-other", home: "org-home" });
    expect((await loadOverview(w.opts)).waiting.map((i) => i.kind)).toEqual(["question"]);
    const other = await loadOverview(w.opts, { organization: "org-other", home: "org-home" });
    expect(other.projects).toHaveLength(1);
    expect(other.waiting).toEqual([]);
  });
});

describe("requests from the dashboard", () => {
  test("approving a waiting plan creates a signed answer request, not a worker or runtime action", async () => {
    const db = await tempDb();
    await upsertProject(db, WIDGETS);
    const w = world(db);
    const plan = await addInboxItem(db, {
      project: "widgets",
      ticket: "WID-2",
      kind: "plan",
      recipient: "coordinator",
      author: "ws/2",
      body: "Add export validation\n\n1. Validate rows.\n2. Test malformed rows.",
      at: new Date(T0),
    });
    await w.warm();
    expect((await loadOverview(w.opts)).waiting).toEqual([expect.objectContaining({ kind: "approval", item: plan })]);
    expect(
      await submitAnswer(w.opts, { project: "widgets", question: plan, text: "approved", author: "Ada" }),
    ).toMatchObject({ ok: true });
    const view = await loadOverview(w.opts);
    expect(view.waiting).toEqual([
      expect.objectContaining({
        kind: "approval",
        item: plan,
        answer: expect.objectContaining({ body: "approved", author: "Ada" }),
      }),
    ]);
  });

  test("a launch is checked against the frontier shown and the claims recorded since; an answer against the open question", async () => {
    const db = await tempDb();
    await upsertProject(db, WIDGETS);
    const w = world(db);
    await w.warm();
    const shown = await loadOverview(w.opts);
    expect(shown.ready.map((r) => [r.id, r.route?.profile, r.launch])).toEqual([
      ["WID-3", "codex", null],
      ["WID-4", undefined, null],
    ]);
    const launch = { project: "widgets", profile: null, author: "Ada" };

    expect(await submitLaunch(w.opts, { ...launch, ticket: "WID-2" })).toMatchObject({ ok: false, code: "in-flight" });
    expect(await submitLaunch(w.opts, { ...launch, project: "gadgets", ticket: "WID-3" })).toMatchObject({
      ok: false,
      code: "unknown-project",
    });
    expect(await submitLaunch(w.opts, { ...launch, ticket: "WID-3" })).toMatchObject({ ok: true });
    expect(await submitLaunch(w.opts, { ...launch, ticket: "WID-4" })).toMatchObject({ ok: true });
    expect((await loadOverview(w.opts)).ready.find((ticket) => ticket.id === "WID-4")?.launch).toMatchObject({
      author: "Ada",
      profile: null,
    });
    // Claimed after the Linear read: the next reading already has it in flight.
    await saveRuntimeHandle(db, {
      project: "widgets",
      ticket: "WID-4",
      runtime: "Conductor",
      handle: "ws/4",
      branch: null,
      at: w.at(1_000),
    });
    await recordEvent(db, { project: "widgets", ticket: "WID-4", kind: "claim", phase: "planning", at: w.at(1_000) });
    w.advance(2_000);
    expect(await submitLaunch(w.opts, { ...launch, ticket: "WID-4" })).toMatchObject({ ok: false, code: "in-flight" });

    const question = await addInboxItem(db, {
      project: "widgets",
      ticket: "WID-2",
      kind: "question",
      recipient: "coordinator",
      author: "ws/2",
      body: "Which table?",
      at: w.at(2_000),
    });
    expect(await submitAnswer(w.opts, { project: "widgets", question, text: "users", author: "Ada" })).toMatchObject({
      ok: true,
    });
    const view = await loadOverview(w.opts);
    expect(view.ready.map((r) => [r.id, r.launch?.author, r.launch?.profile])).toEqual([["WID-3", "Ada", "codex"]]);
    expect(view.waiting.map((i) => [i.kind, i.answer?.body, i.answer?.author])).toEqual([["question", "users", "Ada"]]);
    expect(w.reads.snapshots).toBe(1);
  });

  test("without the database nothing is recorded, and the reason is given", async () => {
    const w = world(null);
    await w.warm();
    expect(
      await submitLaunch(w.opts, { project: "widgets", ticket: "WID-3", profile: null, author: "Ada" }),
    ).toMatchObject({
      ok: false,
      code: "live-down",
    });
  });
});
