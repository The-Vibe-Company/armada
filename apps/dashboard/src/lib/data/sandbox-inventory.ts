import { headers } from "next/headers";
import { cache } from "react";
import type { ControlClient } from "../control";
import { parseSandboxListMetadata, type SandboxListMetadata } from "../sandbox-access";
import { type RecordedTurn, sandboxActivityPage } from "../sandbox-activity";
import {
  filterSandboxes,
  type parseSandboxFilters,
  SANDBOX_INVENTORY_HEADER,
  sandboxFacetCounts,
  sandboxInventoryIncludesDeleted,
  sortSandboxes,
} from "../sandbox-filters";
import { createClient, type Supabase } from "../supabase/server";

export async function loadSandboxInventory(
  supabase: Supabase,
  orgId: string,
  filters: ReturnType<typeof parseSandboxFilters>,
  viewerId: string,
  requestedActivity: string | string[] | undefined,
  control: ControlClient | null,
  metadata: ReturnType<typeof readSandboxMetadata>,
) {
  const turnsRead = control?.post<Record<string, RecordedTurn>>("sandbox/list-turns", { org: orgId }).catch(() => {
    console.error("Recorded sandbox activity is unavailable.");
    return {};
  });
  const viewingDeleted = requestedActivity === "deleted";
  const includeDeleted = sandboxInventoryIncludesDeleted(filters, requestedActivity);
  const [{ inventory, skipped }, turns, deletedCount] = await Promise.all([
    metadata,
    turnsRead ?? {},
    includeDeleted ? null : countDeletedSandboxes(supabase, orgId),
  ]);
  const rows = sortSandboxes(filterSandboxes(inventory, filters, viewerId), filters.sort);
  const now = new Date();
  const matchingDeleted =
    deletedCount === null && (!filters.status.length || filters.status.includes("deleted"))
      ? filterSandboxes(inventory, { ...filters, status: ["deleted"] }, viewerId)
      : [];
  const activityPage = sandboxActivityPage(rows, viewerId, requestedActivity, filters.page, turns, now, {
    rows: viewingDeleted ? sortSandboxes(matchingDeleted, filters.sort, now) : [],
    count: deletedCount ?? matchingDeleted.length,
  });
  const facets = sandboxFacetCounts(inventory, filters, viewerId);
  if (!includeDeleted) facets.status.set("deleted", deletedCount ?? matchingDeleted.length);
  return {
    ...activityPage,
    now,
    total: viewingDeleted ? activityPage.counts.deleted : rows.length,
    inventoryTotal: inventory.filter((row) => row.status !== "deleted").length,
    skipped,
    facets,
  };
}

async function countDeletedSandboxes(supabase: Supabase, orgId: string) {
  const { count, error } = await supabase
    .rpc("sandbox_list_metadata", {}, { head: true, count: "exact" })
    .eq("orgId", orgId)
    .eq("status", "deleted");
  if (error) throw new Error(error.message);
  if (count === null) throw new Error("The deleted sandbox count was unavailable.");
  return count;
}

export const listSandboxMetadata = cache(async (orgId: string) => {
  const [supabase, request] = await Promise.all([createClient(), headers()]);
  return readSandboxMetadata(supabase, orgId, request.get(SANDBOX_INVENTORY_HEADER) === "all");
});

export async function readSandboxMetadata(supabase: Supabase, orgId: string, includeDeleted: boolean) {
  const inventory: SandboxListMetadata[] = [];
  let skipped = 0;
  for (let from = 0; ; from += 500) {
    const query = supabase.rpc("sandbox_list_metadata").eq("orgId", orgId);
    if (!includeDeleted) query.neq("status", "deleted");
    const { data, error } = await query.order("id").range(from, from + 499);
    if (error?.code === "PGRST103") break;
    if (error) throw new Error(error.message);
    const parsed = parseSandboxListMetadata(data);
    inventory.push(...parsed.rows);
    skipped += parsed.skipped.length;
    if (parsed.rows.length + parsed.skipped.length < 500) break;
  }
  return { inventory, skipped };
}
