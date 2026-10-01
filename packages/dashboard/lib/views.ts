// Saved views (THE-895): the filters a person named, pinned in the sidebar
// under the projects. Kept per person and organization in the app's
// database; one name once (saving it again replaces its filters). The rules
// a view is checked under are lib/filters.ts's; this only stores them.
import { type Database, type Queryable, transaction } from "./db";
import { checkView, type SavedView, VIEWS_MAX, type ViewProblem } from "./filters";

/** Whose views: a signed-in person, in the organization they work in. */
export interface ViewOwner {
  organization: string;
  person: string;
}

const view = (r: Record<string, unknown>): SavedView => ({
  id: String(r.id),
  name: String(r.name),
  list: String(r.list) as SavedView["list"],
  query: String(r.query),
});

/** The person's views, oldest first: the order they pinned them. */
export async function listViews(db: Queryable, owner: ViewOwner): Promise<SavedView[]> {
  const rs = await db.query(
    "SELECT id, name, list, query FROM saved_views WHERE organization = $1 AND person = $2 ORDER BY created_at, id",
    [owner.organization, owner.person],
  );
  return rs.rows.map(view);
}

/**
 * Saves a view under its name, checked and made canonical; a name already
 * used replaces that view's filters. Refused past `VIEWS_MAX` views.
 */
export async function saveView(
  db: Database,
  owner: ViewOwner,
  input: { name: unknown; list: unknown; query: unknown },
  now: Date = new Date(),
): Promise<{ ok: true; views: SavedView[] } | { ok: false; problem: ViewProblem }> {
  const checked = checkView(input);
  if (!checked.ok) return checked;
  const { name, list, query } = checked.view;
  return transaction(db, async (tx) => {
    // One person's saves one after another: the count holds.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`views:${owner.organization}:${owner.person}`]);
    const updated = await tx.query(
      "UPDATE saved_views SET list = $4, query = $5 WHERE organization = $1 AND person = $2 AND name = $3 RETURNING id",
      [owner.organization, owner.person, name, list, query],
    );
    if (!updated.rows.length) {
      const count = await tx.query("SELECT count(*) AS n FROM saved_views WHERE organization = $1 AND person = $2", [
        owner.organization,
        owner.person,
      ]);
      if (Number(count.rows[0]?.n ?? 0) >= VIEWS_MAX) return { ok: false as const, problem: "full" as const };
      await tx.query(
        "INSERT INTO saved_views (organization, person, name, list, query, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [owner.organization, owner.person, name, list, query, now],
      );
    }
    return { ok: true as const, views: await listViews(tx, owner) };
  });
}

/** Removes one of the person's views; another person's id removes nothing. */
export async function deleteView(db: Queryable, owner: ViewOwner, id: string): Promise<SavedView[]> {
  if (/^\d{1,18}$/.test(id))
    await db.query("DELETE FROM saved_views WHERE id = $1 AND organization = $2 AND person = $3", [
      id,
      owner.organization,
      owner.person,
    ]);
  return listViews(db, owner);
}
