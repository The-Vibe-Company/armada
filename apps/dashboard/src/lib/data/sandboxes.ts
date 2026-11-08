import type { Sandbox } from "@armada/core";
import { PAGE_SIZE, type SandboxFilters } from "@/lib/sandbox-filters";
import type { Supabase } from "@/lib/supabase/server";

export type SandboxPage = { rows: Sandbox[]; total: number };

/** Row level security decides which sandboxes come back: the filters only narrow what the user may already see. */
export async function listSandboxes(
  supabase: Supabase,
  filters: SandboxFilters,
  viewerId: string,
): Promise<SandboxPage> {
  let query = supabase.from("sandboxes").select("*", { count: "exact" });
  if (filters.status) query = query.eq("status", filters.status);
  else query = query.neq("status", "deleted");
  if (filters.harness) query = query.eq("harness", filters.harness);
  if (filters.golden) query = query.eq("golden_id", filters.golden);
  if (filters.owner) query = query.eq("owner_id", filters.owner === "me" ? viewerId : filters.owner);
  const from = (filters.page - 1) * PAGE_SIZE;
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  if (error) throw new Error(error.message);
  return { rows: data, total: count ?? data.length };
}

export async function getSandbox(supabase: Supabase, id: string): Promise<Sandbox | null> {
  const { data, error } = await supabase.from("sandboxes").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
