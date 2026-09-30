import { afterEach, describe, expect, test } from "bun:test";
import {
  type ArmadaConfig,
  addInboxItem,
  configTemplate,
  type Db,
  type Issue,
  type ProjectInput,
  parseConfig,
  recordEvent,
  type StatusSources,
  saveRuntimeHandle,
  upsertProject,
} from "@armada/core/read";
import { closeTempTurso, issue, tempTurso } from "../../core/test/support.ts";
import { type LoadOptions, loadOverview as load, newCache, type Scope, type Sources } from "../lib/fleet-data.ts";
import { submitAnswer as answer, submitLaunch as launchReq } from "../lib/requests.ts";

afterEach(closeTempTurso);

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
function world(db: Db | null, over: Partial<Sources> = {}) {
  let clock = T0;
  const reads = { snapshots: 0 };
  const sources: Sources = {
    openLive: async () => db,
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
  return {
    opts,
    reads,
    background,
    advance: (ms: number) => {
      clock += ms;
    },
    at: (ms: number) => new Date(T0 + ms),
  };
}

describe("live Fleet reading", () => {
  test("a report recorded after the Linear read shows on the next poll without reading Linear again", async () => {
    const { db } = await tempTurso();
    await upsertProject(db, WIDGETS);
    const w = world(db);

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

  test("with Turso unreachable the view falls back to Linear and GitHub and says so", async () => {
    const { db } = await tempTurso();
    await upsertProject(db, WIDGETS);
    const w = world(db);
    await loadOverview(w.opts);

    db.close();
    const fallback = await loadOverview(w.opts);
    expect(fallback.live.state).toBe("unreachable");
    expect(fallback.rows.map((r) => r.id)).toEqual(["WID-2"]);
    expect(fallback.projects.map((p) => [p.slug, p.coordinator.state])).toEqual([["widgets", "unknown"]]);

    // A fresh server with no registry reading yet shows the repositories it was given.
    const cold = world(null, {
      openLive: async () => {
        throw new Error("connection refused");
      },
    });
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
    await loadOverview(w.opts);

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

describe("organizations", () => {
  test("each organization sees only its projects; projects registered without one go to the first organization", async () => {
    const { db } = await tempTurso();
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
    const launch = { project: "widgets", ticket: "WID-3", profile: null, author: "Ada <ada@example.test>" };
    expect(await submitLaunch(w.opts, launch, other)).toMatchObject({ ok: false, code: "unknown-project" });
    expect(await submitLaunch(w.opts, launch)).toMatchObject({ ok: true });

    // ARMADA_REPOSITORIES, shown while the registry was never read, belongs to the first organization too.
    const cold = world(null);
    expect((await loadOverview(cold.opts)).projects.map((p) => p.slug)).toEqual(["widgets"]);
    expect((await loadOverview(cold.opts, other)).projects).toEqual([]);
  });
});

describe("requests from the dashboard", () => {
  test("a launch is checked against the frontier shown and the claims recorded since; an answer against the open question", async () => {
    const { db } = await tempTurso();
    await upsertProject(db, WIDGETS);
    const w = world(db);
    const shown = await loadOverview(w.opts);
    expect(shown.ready.map((r) => [r.id, r.route?.profile, r.launch])).toEqual([
      ["WID-3", "codex", null],
      ["WID-4", "opus", null],
    ]);
    const launch = { project: "widgets", profile: null, author: "Ada" };

    expect(await submitLaunch(w.opts, { ...launch, ticket: "WID-2" })).toMatchObject({ ok: false, code: "in-flight" });
    expect(await submitLaunch(w.opts, { ...launch, project: "gadgets", ticket: "WID-3" })).toMatchObject({
      ok: false,
      code: "unknown-project",
    });
    expect(await submitLaunch(w.opts, { ...launch, ticket: "WID-3" })).toMatchObject({ ok: true });
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

  test("without Turso nothing is recorded, and the reason is given", async () => {
    const w = world(null);
    await loadOverview(w.opts);
    expect(
      await submitLaunch(w.opts, { project: "widgets", ticket: "WID-3", profile: null, author: "Ada" }),
    ).toMatchObject({
      ok: false,
      code: "live-down",
    });
  });
});
