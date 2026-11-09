import type { Sandbox, SandboxListMetadata } from "@armada/core";
import { parseSandboxListMetadata } from "@/lib/sandbox-access";
import { PAGE_SIZE, type SandboxFilters } from "@/lib/sandbox-filters";
import type { Supabase } from "@/lib/supabase/server";
import { selectedOrganization } from "./selected-org";

export type SandboxPage = { rows: SandboxListMetadata[]; total: number };

/**
 * One page of the selected organization's sandboxes, from the #680 metadata read port: every current member gets
 * every launched sandbox of the organization, with `canOpen`/`canManage` as hints only, and the raw `sandboxes`
 * table stays interior-only. Filters, count and paging run in the database; the rows are checked against the contract.
 */
export async function listSandboxes(
  supabase: Supabase,
  filters: SandboxFilters,
  viewerId: string,
): Promise<SandboxPage> {
  const selected = await selectedOrganization();
  if (!selected) return { rows: [], total: 0 };
  const orgId = selected.org.id;
  const filtered = (options: { count: "exact"; head?: boolean }) => {
    let query = supabase.rpc("sandbox_list_metadata", {}, options).eq("orgId", orgId);
    if (filters.status) query = query.eq("status", filters.status);
    else query = query.neq("status", "deleted");
    if (filters.harness) query = query.eq("harness", filters.harness);
    if (filters.owner) query = query.eq("ownerId", filters.owner === "me" ? viewerId : filters.owner);
    return query;
  };
  const from = (filters.page - 1) * PAGE_SIZE;
  const { data, error, count } = await filtered({ count: "exact" })
    .order("createdAt", { ascending: false })
    .order("id")
    .range(from, from + PAGE_SIZE - 1);
  if (error?.code === "PGRST103") {
    // A page past the last one (a stale link): no rows, and the real total for the pager.
    const head = await filtered({ count: "exact", head: true });
    if (head.error) throw new Error(head.error.message);
    return { rows: [], total: head.count ?? 0 };
  }
  if (error) throw new Error(error.message);
  const rows = parseSandboxListMetadata(data);
  return { rows, total: count ?? rows.length };
}

/** The listed metadata of one sandbox of the selected organization, or null when the server lists no such sandbox. */
export async function getSandboxMetadata(supabase: Supabase, id: string): Promise<SandboxListMetadata | null> {
  const selected = await selectedOrganization();
  if (!selected) return null;
  const { data, error } = await supabase
    .rpc("sandbox_list_metadata")
    .eq("id", id)
    .eq("orgId", selected.org.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? (parseSandboxListMetadata([data])[0] ?? null) : null;
}

/** The interior row. Row level security returns it only to its owner or a current organization admin. */
export async function getSandbox(supabase: Supabase, id: string): Promise<Sandbox | null> {
  const selected = await selectedOrganization();
  if (!selected) return null;
  const { data, error } = await supabase
    .from("sandboxes")
    .select("*")
    .eq("id", id)
    .eq("org_id", selected.org.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
