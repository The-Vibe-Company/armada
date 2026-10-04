import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "../lib/db.ts";
import { VIEWS_MAX } from "../lib/filters.ts";
import { deleteView, listViews, saveView, type ViewOwner } from "../lib/views.ts";
import { addOrganizations, scalar, tempDatabase } from "./support.ts";

// Saved views (THE-895) on the app's database: invented people and organizations.

const open: Database[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.end().catch(() => {})));
});

async function tempDb(): Promise<Database> {
  const db = await tempDatabase();
  open.push(db);
  await addOrganizations(db, "org-a", "org-b");
  for (const id of ["ada", "bob"])
    await db.query(`INSERT INTO "user" ("id", "name", "email", "emailVerified") VALUES ($1, $1, $2, true)`, [
      id,
      `${id}@example.test`,
    ]);
  return db;
}

const ADA: ViewOwner = { organization: "org-a", person: "ada" };
const BOB: ViewOwner = { organization: "org-a", person: "bob" };
const ADA_ELSEWHERE: ViewOwner = { organization: "org-b", person: "ada" };
const T0 = new Date("2026-10-01T12:00:00Z");

describe("saved views", () => {
  test("are each person's, per organization, in the order they were pinned, kept canonical", async () => {
    const db = await tempDb();
    const saved = await saveView(db, ADA, { name: "Red CI", list: "projects", query: "sort=age&state=blocked" }, T0);
    expect(saved).toEqual({
      ok: true,
      views: [{ id: expect.any(String), name: "Red CI", list: "projects", query: "state=blocked&sort=age" }],
    });
    await saveView(db, ADA, { name: "Mine", list: "validations", query: "mine=1" }, new Date(T0.getTime() + 1000));
    expect((await listViews(db, ADA)).map((v) => v.name)).toEqual(["Red CI", "Mine"]);
    expect(await listViews(db, BOB)).toEqual([]);
    expect(await listViews(db, ADA_ELSEWHERE)).toEqual([]);
  });

  test("saving a name again replaces its filters; a bad name or list is refused; twenty at most", async () => {
    const db = await tempDb();
    await saveView(db, ADA, { name: "Red CI", list: "validations", query: "state=pending" }, T0);
    await saveView(db, ADA, { name: "Red CI", list: "projects", query: "state=blocked" }, T0);
    expect(await listViews(db, ADA)).toEqual([
      { id: expect.any(String), name: "Red CI", list: "projects", query: "state=blocked" },
    ]);
    expect(await saveView(db, ADA, { name: "", list: "projects", query: "" })).toEqual({ ok: false, problem: "name" });
    expect(await saveView(db, ADA, { name: "x", list: "keys", query: "" })).toEqual({ ok: false, problem: "list" });
    for (let k = 1; k < VIEWS_MAX; k++)
      await saveView(db, ADA, { name: `View ${k}`, list: "projects", query: `q=${k}` });
    expect(await saveView(db, ADA, { name: "One more", list: "projects", query: "" })).toEqual({
      ok: false,
      problem: "full",
    });
    // Saving a name already kept replaces it: allowed at the limit.
    expect((await saveView(db, ADA, { name: "View 3", list: "projects", query: "q=three" })).ok).toBe(true);
    expect(await scalar(db, "SELECT count(*) FROM saved_views WHERE person = 'ada'")).toBe(VIEWS_MAX);
  });

  test("a person removes their own views only; their organization or account gone takes them along", async () => {
    const db = await tempDb();
    const saved = await saveView(db, ADA, { name: "Red CI", list: "projects", query: "state=blocked" }, T0);
    const id = saved.ok ? (saved.views[0]?.id ?? "") : "";
    expect(await deleteView(db, BOB, id)).toEqual([]);
    expect(await listViews(db, ADA)).toHaveLength(1);
    expect(await deleteView(db, ADA, "not-an-id")).toHaveLength(1);
    expect(await deleteView(db, ADA, id)).toEqual([]);

    await saveView(db, ADA, { name: "Again", list: "projects", query: "" }, T0);
    await saveView(db, ADA_ELSEWHERE, { name: "There", list: "projects", query: "" }, T0);
    await db.query(`DELETE FROM "organization" WHERE id = 'org-b'`);
    expect(await listViews(db, ADA_ELSEWHERE)).toEqual([]);
    await db.query(`DELETE FROM "user" WHERE id = 'ada'`);
    expect(await scalar(db, "SELECT count(*) FROM saved_views")).toBe(0);
  });
});
