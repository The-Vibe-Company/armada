import type { SandboxStatus } from "@armada/core";
import { filtersToSearch } from "./sandbox-filters";
import { sandboxListName } from "./sandbox-list-name";
import type { Supabase } from "./supabase/server";

export const INLINE_LIVE_LIMIT = 5;
const LIVE_STATUSES: SandboxStatus[] = ["starting", "ready", "running", "stopping"];
export const LIVE_SANDBOXES_HREF = `/sandboxes${filtersToSearch({ status: LIVE_STATUSES })}`;

export type LiveSandbox = { id: string; label: string; status: SandboxStatus };
export type LiveSandboxes = { rows: LiveSandbox[]; total: number };

export async function readLiveSandboxes(supabase: Supabase, organizationId: string) {
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
    rows: data.map((row) => ({ id: row.id, label: sandboxListName(row), status: row.status })),
    total: count,
  } satisfies LiveSandboxes;
}
