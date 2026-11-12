import type { Golden } from "@armada/core";
import type { Supabase } from "@/lib/supabase/server";
import { selectedOrganization } from "./selected-org";

/**
 * A golden row as read here. `removed_at` (#566) is set once the golden is retired: the row stays readable as a
 * tombstone so the sandboxes started from it keep their history. Absent before that migration.
 */
export type GoldenRow = Golden & { removed_at?: string | null };

/**
 * The goldens of the selected org that can still be used: the Goldens page, launch and rebuild choose from these.
 * A removed golden is filtered here, in the query; row level security keeps tombstones readable.
 */
export async function listGoldens(supabase: Supabase): Promise<GoldenRow[]> {
  const selected = await selectedOrganization();
  if (!selected) return [];
  const { data, error } = await supabase
    .from("goldens")
    .select("*")
    .eq("org_id", selected.org.id)
    .is("removed_at", null)
    .order("name");
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Every golden of the selected org the viewer may read, removed ones included: for naming the golden of a sandbox
 * (and filtering by it), which must not lose its history when the golden is retired. Never a source for launch.
 */
export async function listGoldenHistory(supabase: Supabase): Promise<GoldenRow[]> {
  const selected = await selectedOrganization();
  if (!selected) return [];
  const { data, error } = await supabase.from("goldens").select("*").eq("org_id", selected.org.id).order("name");
  if (error) throw new Error(error.message);
  return data;
}

/** The selected-org label for a sandbox's golden, including readable tombstones. RLS still owns visibility. */
export async function findGoldenLabel(
  supabase: Supabase,
  id: string,
): Promise<Pick<GoldenRow, "id" | "name" | "removed_at"> | null> {
  const selected = await selectedOrganization();
  if (!selected) return null;
  const { data, error } = await supabase
    .from("goldens")
    .select("id,name,removed_at")
    .eq("id", id)
    .eq("org_id", selected.org.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * A golden of the selected org that the database records as removed, or null: the confirmation after a removal names
 * it from this row, never from the URL, so a crafted link cannot announce a removal that did not happen.
 */
export async function findRemovedGolden(supabase: Supabase, id: string): Promise<GoldenRow | null> {
  const selected = await selectedOrganization();
  if (!selected) return null;
  const { data, error } = await supabase
    .from("goldens")
    .select("*")
    .eq("id", id)
    .eq("org_id", selected.org.id)
    .not("removed_at", "is", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
