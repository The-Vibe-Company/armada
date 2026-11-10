import type { CredentialKind, Sandbox, SandboxCost, SandboxListMetadata } from "@armada/core";
import { parseSandboxListMetadata } from "@/lib/sandbox-access";
import { costOfRow } from "@/lib/sandbox-cost";
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

/**
 * The kind of each readable account among `ids`, by id. Row level security returns an org account to its members and a
 * personal one to its owner: an account the viewer cannot read is absent, and its sandbox's cost is "estimated".
 */
export async function credentialKinds(supabase: Supabase, ids: readonly (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  const kinds = new Map<string, CredentialKind>();
  if (wanted.length === 0) return kinds;
  const { data, error } = await supabase.from("credentials").select("id,kind").in("id", wanted);
  if (error) throw new Error(error.message);
  for (const row of data ?? []) kinds.set(row.id, row.kind);
  return kinds;
}

/**
 * The cost of the listed sandboxes the viewer may open, by id. The usage columns are interior: row level security
 * returns them to the owner and the org's admins only, as the server's list does, so another member's row has none.
 */
export async function listSandboxCosts(
  supabase: Supabase,
  rows: readonly Pick<SandboxListMetadata, "id" | "canOpen">[],
): Promise<Map<string, SandboxCost>> {
  const ids = rows.filter((row) => row.canOpen).map((row) => row.id);
  const costs = new Map<string, SandboxCost>();
  if (ids.length === 0) return costs;
  const { data, error } = await supabase
    .from("sandboxes")
    .select("id,credential_id,usage_turns,usage_runtime_seconds,usage_running_since")
    .in("id", ids);
  if (error) throw new Error(error.message);
  const kinds = await credentialKinds(
    supabase,
    (data ?? []).map((row) => row.credential_id),
  );
  for (const row of data ?? []) costs.set(row.id, costOfRow(row, kinds.get(row.credential_id ?? "") ?? null));
  return costs;
}
