import { HARNESSES } from "@armada/core";
import { headers } from "next/headers";
import { cache } from "react";
import type { ControlClient } from "../control";
import { parseSandboxListMetadata, type SandboxListMetadata } from "../sandbox-access";
import { type RecordedTurn, sandboxActivityPage } from "../sandbox-activity";
import {
  canPushDownDeletedSearch,
  filterSandboxes,
  matchesSandboxSearch,
  type parseSandboxFilters,
  SANDBOX_INVENTORY_HEADER,
  type SandboxFilters,
  type SandboxSearchRow,
  sandboxFacetCounts,
  sandboxInventoryIncludesDeleted,
  sortSandboxes,
} from "../sandbox-filters";
import { createClient, type Supabase } from "../supabase/server";

const DELETED_SEARCH_COLUMNS = "id,providerSandboxId,displayLabel,harness,createdAt";

const recordedTurnsCache = cache(() => new Map<string, Promise<Record<string, RecordedTurn>>>());

async function fetchRecordedTurns(organizationId: string, control: ControlClient) {
  const turns: Record<string, RecordedTurn> = {};
  try {
    const result = await control.post<unknown>("sandbox/list-turns", { org: organizationId });
    if (result && typeof result === "object" && !Array.isArray(result)) {
      for (const [id, state] of Object.entries(result)) {
        if (state === "queued" || state === "running" || state === "finished") turns[id] = state;
      }
    }
  } catch {
    console.error("Recorded sandbox activity is unavailable.");
  }
  return turns;
}

export function readRecordedTurns(organizationId: string, control: ControlClient | null) {
  if (!control) return Promise.resolve({} as Record<string, RecordedTurn>);
  const pending = recordedTurnsCache();
  let read = pending.get(organizationId);
  if (!read) {
    read = fetchRecordedTurns(organizationId, control);
    pending.set(organizationId, read);
  }
  return read;
}

export async function loadSandboxInventory(
  supabase: Supabase,
  orgId: string,
  filters: ReturnType<typeof parseSandboxFilters>,
  viewerId: string,
  requestedActivity: string | string[] | undefined,
  control: ControlClient | null,
  metadata: ReturnType<typeof readSandboxMetadata>,
) {
  const turnsRead = readRecordedTurns(orgId, control);
  const includeDeleted = sandboxInventoryIncludesDeleted(filters);
  const [{ inventory, skipped }, turns, deletedFacetCount] = await Promise.all([
    metadata,
    turnsRead,
    includeDeleted ? null : countDeletedSandboxes(supabase, orgId, filters, viewerId),
  ]);
  const now = new Date();
  const rows = sortSandboxes(filterSandboxes(inventory, filters, viewerId), filters.sort, now);
  const activityPage = sandboxActivityPage(rows, viewerId, requestedActivity, filters.page, turns, now);
  const facets = sandboxFacetCounts(inventory, filters, viewerId);
  if (deletedFacetCount !== null) facets.status.set("deleted", deletedFacetCount);
  return {
    ...activityPage,
    now,
    total: rows.length,
    inventoryTotal: inventory.filter((row) => row.status !== "deleted").length,
    skipped,
    facets,
  };
}

function postgrestIn(values: readonly string[]) {
  return `(${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")})`;
}

type DeletedFacetQuery<T> = {
  eq(column: "orgId" | "status", value: string): T;
  in(column: "provider" | "harness" | "ownerId" | "machineSize", values: readonly string[]): T;
  is(column: "machineSize", value: null): T;
  filter(column: "model", operator: "in", value: string): T;
  or(filters: string): T;
};

function applyDeletedFacetFilters<Q extends DeletedFacetQuery<Q>>(
  query: Q,
  orgId: string,
  filters: SandboxFilters,
  viewerId: string,
) {
  let filtered = query.eq("orgId", orgId).eq("status", "deleted");
  if (filters.provider.length) filtered = filtered.in("provider", filters.provider);
  if (filters.harness.length) filtered = filtered.in("harness", filters.harness);
  if (filters.owner.length) {
    const owners = [...new Set(filters.owner.map((value) => (value === "me" ? viewerId : value)))];
    filtered = filtered.in("ownerId", owners);
  }
  if (filters.size.length) {
    const known = filters.size.filter((value) => value !== "unknown");
    if (!filters.size.includes("unknown")) filtered = filtered.in("machineSize", known);
    else if (known.length === 0) filtered = filtered.is("machineSize", null);
    else filtered = filtered.or(`machineSize.is.null,machineSize.in.(${known.join(",")})`);
  }
  if (filters.model.length) {
    const quoted = postgrestIn(filters.model);
    if (filters.model.includes("unknown")) filtered = filtered.or(`model.is.null,model.in.${quoted}`);
    else filtered = filtered.filter("model", "in", quoted);
  }
  return filtered;
}

function isSearchableDeletedRow(value: unknown): value is SandboxSearchRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.displayLabel === "string" &&
    row.displayLabel.length > 0 &&
    typeof row.createdAt === "string" &&
    !Number.isNaN(Date.parse(row.createdAt)) &&
    (row.providerSandboxId === null ||
      (typeof row.providerSandboxId === "string" && row.providerSandboxId.length > 0)) &&
    typeof row.harness === "string" &&
    (HARNESSES as readonly string[]).includes(row.harness)
  );
}

function escapePostgrestIlike(value: string) {
  return value.replaceAll("_", "\\_");
}

async function countDeletedSandboxes(supabase: Supabase, orgId: string, filters: SandboxFilters, viewerId: string) {
  if (!filters.q || canPushDownDeletedSearch(filters.q)) {
    let query = applyDeletedFacetFilters(
      supabase.rpc("sandbox_list_metadata", {}, { head: true, count: "exact" }),
      orgId,
      filters,
      viewerId,
    );
    if (filters.q) {
      const pattern = `*${escapePostgrestIlike(filters.q)}*`;
      query = query.or(`displayLabel.ilike.${pattern},providerSandboxId.ilike.${pattern}`);
    }
    const { count, error } = await query;
    if (error) throw new Error(error.message);
    if (count === null) throw new Error("The deleted sandbox count was unavailable.");
    return count;
  }
  const q = filters.q.toLocaleLowerCase();
  let count = 0;
  for (let from = 0; ; from += 500) {
    const { data, error } = await applyDeletedFacetFilters(
      supabase.rpc("sandbox_list_metadata").select(DELETED_SEARCH_COLUMNS),
      orgId,
      filters,
      viewerId,
    )
      .order("id")
      .range(from, from + 499);
    if (error?.code === "PGRST103") break;
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) throw new Error("The deleted sandbox list did not match its contract.");
    for (const item of data) {
      if (isSearchableDeletedRow(item) && matchesSandboxSearch(item, q)) count++;
    }
    if (data.length < 500) break;
  }
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
