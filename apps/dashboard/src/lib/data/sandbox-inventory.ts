import type { ControlClient } from "../control";
import { parseSandboxListMetadata, type SandboxListMetadata } from "../sandbox-access";
import { type RecordedTurn, sandboxActivityPage } from "../sandbox-activity";
import { filterSandboxes, type parseSandboxFilters, sandboxFacetCounts, sortSandboxes } from "../sandbox-filters";
import type { Supabase } from "../supabase/server";

export async function loadSandboxInventory(
  supabase: Supabase,
  orgId: string,
  filters: ReturnType<typeof parseSandboxFilters>,
  viewerId: string,
  requestedActivity: string | string[] | undefined,
  control: ControlClient | null,
) {
  const turnsRead = control?.post<Record<string, RecordedTurn>>("sandbox/list-turns", { org: orgId });
  const [{ inventory, skipped }, turns] = await Promise.all([readInventory(supabase, orgId), turnsRead ?? {}]);
  const rows = sortSandboxes(filterSandboxes(inventory, filters, viewerId), filters.sort);
  const now = new Date();
  const activityPage = sandboxActivityPage(rows, viewerId, requestedActivity, filters.page, turns, now);
  return {
    ...activityPage,
    now,
    total: rows.length,
    inventoryTotal: inventory.filter((row) => row.status !== "deleted").length,
    skipped,
    facets: sandboxFacetCounts(inventory, filters, viewerId),
  };
}

async function readInventory(supabase: Supabase, orgId: string) {
  const inventory: SandboxListMetadata[] = [];
  let skipped = 0;
  for (let from = 0; ; from += 500) {
    const { data, error } = await supabase
      .rpc("sandbox_list_metadata")
      .eq("orgId", orgId)
      .order("id")
      .range(from, from + 499);
    if (error?.code === "PGRST103") break;
    if (error) throw new Error(error.message);
    const parsed = parseSandboxListMetadata(data);
    inventory.push(...parsed.rows);
    skipped += parsed.skipped.length;
    if (parsed.rows.length + parsed.skipped.length < 500) break;
  }
  return { inventory, skipped };
}
