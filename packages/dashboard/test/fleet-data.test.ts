import { afterEach, describe, expect, test } from "bun:test";
import {
  type ArmadaConfig,
  configTemplate,
  type Db,
  type Issue,
  type ProjectInput,
  parseConfig,
  recordEvent,
  type StatusSources,
  upsertProject,
} from "@armada/core/read";
import { closeTempTurso, issue, tempTurso } from "../../core/test/support.ts";
import { type LoadOptions, loadOverview, newCache, type Sources } from "../lib/fleet-data.ts";

afterEach(closeTempTurso);

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

/** One project with one worker implementing WID-2; `reads` counts the Linear and GitHub reads. */
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
      return snapshot(config, clock, [worker]);
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

  test("a stale reading is served while it refreshes; a failed refresh keeps it with a warning", async () => {
    let fail = false;
    const w = world(null);
    const read = w.opts.sources.readSnapshot;
    w.opts.sources.readSnapshot = async (config) => {
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
  });
});
