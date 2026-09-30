import { afterEach, describe, expect, test } from "bun:test";
import { listProjects, migrate, openTurso, SCHEMA_VERSION, upsertProject } from "../src/turso.ts";
import { closeTempTurso, tempTurso, trackDb } from "./support.ts";

afterEach(closeTempTurso);

describe("Turso schema", () => {
  test("migrations apply once and can run again from another process", async () => {
    const { url, db } = await tempTurso();
    expect(await migrate(db)).toBe(SCHEMA_VERSION);
    const again = trackDb(await openTurso({ url }));
    const versions = await again.execute("SELECT version FROM schema_migrations");
    expect(versions.rows.map((r) => Number(r.version))).toEqual([SCHEMA_VERSION]);
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
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    });
  });
});
