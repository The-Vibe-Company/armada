import { headers } from "next/headers";
import { listSandboxMetadata } from "./data/sandbox-inventory";
import { INLINE_LIVE_LIMIT, LIVE_STATUSES, type LiveSandboxes } from "./live-sandbox-view";
import { SANDBOX_INVENTORY_HEADER, sortSandboxes } from "./sandbox-filters";
import { sandboxListName } from "./sandbox-list-name";
import type { Supabase } from "./supabase/server";

export async function readLiveSandboxes(supabase: Supabase, organizationId: string) {
  if ((await headers()).has(SANDBOX_INVENTORY_HEADER)) {
    try {
      const { inventory } = await listSandboxMetadata(organizationId);
      const live = inventory.filter(({ status, canOpen }) => canOpen && LIVE_STATUSES.includes(status));
      return {
        rows: sortSandboxes(live, "newest").slice(0, INLINE_LIVE_LIMIT).map(toLiveSandbox),
        total: live.length,
      } satisfies LiveSandboxes;
    } catch {
      return null;
    }
  }
  const { data, count, error } = await supabase
    .rpc("sandbox_list_metadata", {}, { count: "exact", get: true })
    .select("id, status, providerSandboxId, displayLabel, harness, createdAt")
    .eq("orgId", organizationId)
    .eq("canOpen", true)
    .in("status", LIVE_STATUSES)
    .order("createdAt", { ascending: false })
    .order("id")
    .limit(INLINE_LIVE_LIMIT);
  if (error || count === null) return null;
  return {
    rows: data.map(toLiveSandbox),
    total: count,
  } satisfies LiveSandboxes;
}

function toLiveSandbox(
  row: Parameters<typeof sandboxListName>[0] & Pick<LiveSandboxes["rows"][number], "id" | "status">,
) {
  return { id: row.id, label: sandboxListName(row), status: row.status };
}
