import { afterEach, describe, expect, test } from "bun:test";
import {
  assignUnownedProjects,
  lastCoordinatorSeen,
  lastEventTimes,
  latestEvents,
  listProjects,
  migrate,
  openRuntimeHandles,
  openTurso,
  recordCoordinatorSeen,
  recordEvent,
  releaseRuntimeHandle,
  SCHEMA_VERSION,
  saveRuntimeHandle,
  upsertProject,
} from "../src/turso.ts";
import { closeTempTurso, tempTurso, trackDb } from "./support.ts";

afterEach(closeTempTurso);

describe("Turso schema", () => {
  test("migrations apply once and can run again from another process", async () => {
    const { url, db } = await tempTurso();
    expect(await migrate(db)).toBe(SCHEMA_VERSION);
    const again = trackDb(await openTurso({ url }));
    const versions = await again.execute("SELECT version FROM schema_migrations");
    expect(versions.rows.map((r) => Number(r.version))).toEqual(
      Array.from({ length: SCHEMA_VERSION }, (_, k) => k + 1),
    );
    const tables = await again.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(tables.rows.map((r) => String(r.name))).toEqual(
      expect.arrayContaining(["events", "inbox_items", "leases", "projects", "runtime_handles"]),
    );
  });

  test("a project is registered once per slug; an update keeps its creation time", async () => {
    const { db } = await tempTurso();
    const p = { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "DEMO-1" };
    await upsertProject(db, p, new Date("2026-03-01T00:00:00Z"));
    await upsertProject(db, { ...p, name: "Widgets 2" }, new Date("2026-03-02T00:00:00Z"));
    await upsertProject(db, { slug: "gadgets", name: "Gadgets", repository: "acme/gadgets", programRoot: "GAD-1" });
    const [gadgets, widgets] = await listProjects(db);
    expect(gadgets?.slug).toBe("gadgets");
    expect(widgets).toEqual({
      ...p,
      name: "Widgets 2",
      organization: null,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    });
  });

  test("projects without an organization go to the one given, once; a project never changes organization", async () => {
    const { db } = await tempTurso();
    const project = (slug: string) => ({ slug, name: slug, repository: `acme/${slug}`, programRoot: "DEMO-1" });
    await upsertProject(db, project("widgets"));
    await upsertProject(db, project("gadgets"));
    expect(await assignUnownedProjects(db, "org-first")).toBe(2);
    // Registered later, as the CLI does before it signs in.
    await upsertProject(db, project("sprockets"));
    expect(await assignUnownedProjects(db, "org-other")).toBe(1);
    expect(await assignUnownedProjects(db, "org-other")).toBe(0);
    expect((await listProjects(db)).map((p) => [p.slug, p.organization])).toEqual([
      ["gadgets", "org-first"],
      ["sprockets", "org-other"],
      ["widgets", "org-first"],
    ]);
  });
});

describe("live reading", () => {
  const at = (t: string) => new Date(`2026-03-04T${t}:00Z`);

  test("the newest event of each ticket, the coordinator's last inbox read and the open handles", async () => {
    const { db } = await tempTurso();
    const report = (ticket: string, phase: string, t: string, project = "widgets") =>
      recordEvent(db, { project, ticket, kind: "report", phase, message: `${phase} note`, at: at(t) });
    await report("W-1", "planning", "09:00");
    await report("W-1", "implementing", "09:10");
    await report("W-2", "shipping", "09:05");
    await report("W-1", "shipping", "09:20", "gadgets");
    expect(await lastCoordinatorSeen(db, "widgets")).toBeNull();
    await recordCoordinatorSeen(db, { project: "widgets", at: at("09:30") });
    await recordCoordinatorSeen(db, { project: "widgets", at: at("09:40") });

    const latest = await latestEvents(db, "widgets");
    expect(Object.keys(latest).sort()).toEqual(["W-1", "W-2"]);
    expect(latest["W-1"]).toMatchObject({ kind: "report", phase: "implementing", message: "implementing note" });
    // A window keeps the read to tickets with recent events.
    expect(Object.keys(await latestEvents(db, "widgets", { since: at("09:08") }))).toEqual(["W-1"]);
    // Coordinator reads belong to no ticket.
    expect(Object.keys(await lastEventTimes(db, "widgets")).sort()).toEqual(["W-1", "W-2"]);
    expect(await lastCoordinatorSeen(db, "widgets")).toBe("2026-03-04T09:40:00.000Z");
    expect(await lastCoordinatorSeen(db, "gadgets")).toBeNull();

    const handle = { project: "widgets", runtime: "Conductor", branch: null, at: at("09:00") };
    await saveRuntimeHandle(db, { ...handle, ticket: "W-1", handle: "ws-1" });
    await saveRuntimeHandle(db, { ...handle, ticket: "W-2", handle: "ws-2" });
    await releaseRuntimeHandle(db, "widgets", "W-2", at("09:50"));
    const handles = await openRuntimeHandles(db, "widgets");
    expect(handles.map((h) => [h.ticket, h.handle])).toEqual([["W-1", "ws-1"]]);
  });
});
