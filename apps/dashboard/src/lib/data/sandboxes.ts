import type { CredentialKind, Sandbox, SandboxCost, SandboxListMetadata } from "@armada/core";
import { isUuid } from "@/lib/action";
import { parseSandboxListMetadata } from "@/lib/sandbox-access";
import { costOfRow } from "@/lib/sandbox-cost";
import {
  type Facet,
  filterSandboxes,
  PAGE_SIZE,
  type SandboxFilters,
  sandboxFacetCounts,
  sortSandboxes,
} from "@/lib/sandbox-filters";
import type { Supabase } from "@/lib/supabase/server";
import { selectedOrganization } from "./selected-org";

export type SandboxPage = {
  rows: SandboxListMetadata[];
  total: number;
  inventoryTotal: number;
  facets: Record<Facet, Map<string, number>>;
};

/** Read the existing RLS-protected metadata port in stable pages, then filter the whole organization inventory.
 * No interior rows or new server capability are needed for search and cross-facet counts.
 */
export async function listSandboxes(
  supabase: Supabase,
  filters: SandboxFilters,
  viewerId: string,
): Promise<SandboxPage> {
  const selected = await selectedOrganization();
  const inventory: SandboxListMetadata[] = [];
  if (selected) {
    const batch = 500;
    for (let from = 0; ; from += batch) {
      const { data, error } = await supabase
        .rpc("sandbox_list_metadata")
        .eq("orgId", selected.org.id)
        .order("id")
        .range(from, from + batch - 1);
      if (error?.code === "PGRST103") break;
      if (error) throw new Error(error.message);
      const rows = parseSandboxListMetadata(data);
      inventory.push(...rows);
      if (rows.length < batch) break;
    }
  }
  const matching = sortSandboxes(filterSandboxes(inventory, filters, viewerId), filters.sort);
  const from = (filters.page - 1) * PAGE_SIZE;
  return {
    rows: matching.slice(from, from + PAGE_SIZE),
    total: matching.length,
    inventoryTotal: inventory.filter((row) => row.status !== "deleted").length,
    facets: sandboxFacetCounts(inventory, filters, viewerId),
  };
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
 * personal one to its owner: an account the viewer cannot read is absent, and its sandbox's cost is "API-equivalent".
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
export function listSandboxCosts(
  supabase: Supabase,
  rows: readonly Pick<SandboxListMetadata, "id" | "canOpen">[],
): Promise<Map<string, SandboxCost>> {
  return sandboxCosts(
    supabase,
    rows.filter((row) => row.canOpen).map((row) => row.id),
  );
}

/** The cost of each sandbox among `ids` whose row row level security returns to the viewer (owner or org admin), by id. */
export async function sandboxCosts(supabase: Supabase, ids: readonly string[]): Promise<Map<string, SandboxCost>> {
  const costs = new Map<string, SandboxCost>();
  // A malformed sandbox id is never queried.
  const wanted = [...new Set(ids)].filter(isUuid);
  if (wanted.length === 0) return costs;
  const { data, error } = await supabase
    .from("sandboxes")
    .select("id,harness,credential_id,usage_turns,usage_runtime_seconds,usage_running_since")
    .in("id", wanted);
  if (error) throw new Error(error.message);
  const kinds = await credentialKinds(
    supabase,
    (data ?? []).map((row) => row.credential_id),
  );
  for (const row of data ?? []) costs.set(row.id, costOfRow(row, kinds.get(row.credential_id ?? "") ?? null));
  return costs;
}
