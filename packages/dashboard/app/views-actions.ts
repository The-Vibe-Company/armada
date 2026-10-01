"use server";

// Saved views (THE-895), as server actions: name the filters of a list and
// pin them in the sidebar, or remove one. Each checks access first; a view
// belongs to the signed-in person, in the organization they work in. Under
// the shared-password gate nobody is a person: the shell keeps views in the
// browser instead, and these refuse.
import { requireFleetAccess } from "@/lib/access";
import { appDatabase } from "@/lib/app-db";
import type { SavedView, ViewError } from "@/lib/filters";
import { deleteView as remove, saveView as save, type ViewOwner } from "@/lib/views";

export type ViewResult = { ok: true; views: SavedView[] } | { ok: false; problem: ViewError };

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

async function owner(): Promise<ViewOwner | null> {
  const access = await requireFleetAccess();
  if (access.kind !== "account") return null;
  return { organization: access.viewer.organization.id, person: access.viewer.user.id };
}

export async function saveView(form: FormData): Promise<ViewResult> {
  const who = await owner();
  if (!who) return { ok: false, problem: "no-person" };
  try {
    const db = await appDatabase();
    if (!db) return { ok: false, problem: "failed" };
    return await save(db, who, { name: text(form, "name"), list: text(form, "list"), query: text(form, "query") });
  } catch (err) {
    console.error(`armada dashboard: saving a view failed: ${err instanceof Error ? err.message : err}`);
    return { ok: false, problem: "failed" };
  }
}

export async function deleteView(form: FormData): Promise<ViewResult> {
  const who = await owner();
  if (!who) return { ok: false, problem: "no-person" };
  try {
    const db = await appDatabase();
    if (!db) return { ok: false, problem: "failed" };
    return { ok: true, views: await remove(db, who, text(form, "id")) };
  } catch (err) {
    console.error(`armada dashboard: removing a view failed: ${err instanceof Error ? err.message : err}`);
    return { ok: false, problem: "failed" };
  }
}
