import { headers } from "next/headers";
import { type ControlClient, createControlClient } from "./control";
import { listSandboxMetadata, readRecordedTurns } from "./data/sandbox-inventory";
import { readViewer } from "./data/viewer";
import { mcpUrl } from "./env";
import { INLINE_LIVE_LIMIT, LIVE_STATUSES, type LiveSandboxes } from "./live-sandbox-view";
import { isSandboxWorking, type RecordedTurn } from "./sandbox-activity";
import { SANDBOX_INVENTORY_HEADER, sortSandboxes } from "./sandbox-filters";
import { sandboxListName } from "./sandbox-list-name";
import type { Supabase } from "./supabase/server";

const LIVE_COLUMNS = "id, status, expiresAt, providerSandboxId, displayLabel, harness, createdAt";

type LiveMetadataRow = Parameters<typeof sandboxListName>[0] & {
  id: string;
  status: LiveSandboxes["rows"][number]["status"];
  expiresAt?: string | null;
  createdAt: string;
};

async function resolveControl(control: ControlClient | null | undefined) {
  if (control !== undefined) return control;
  const serverUrl = mcpUrl();
  const viewer = serverUrl ? await readViewer() : null;
  return serverUrl && viewer?.token ? createControlClient({ serverUrl, token: viewer.token }) : null;
}

function liveMetadataQuery(supabase: Supabase, organizationId: string, count?: "exact") {
  return supabase
    .rpc("sandbox_list_metadata", {}, count ? { count, get: true } : { get: true })
    .select(LIVE_COLUMNS)
    .eq("orgId", organizationId)
    .eq("canOpen", true)
    .order("createdAt", { ascending: false })
    .order("id");
}

export async function queryLiveSandboxes(
  supabase: Supabase,
  organizationId: string,
  control: ControlClient | null,
  now = new Date(),
) {
  const [liveQuery, turns] = await Promise.all([
    liveMetadataQuery(supabase, organizationId, "exact").in("status", LIVE_STATUSES).limit(INLINE_LIVE_LIMIT),
    readRecordedTurns(organizationId, control),
  ]);
  if (liveQuery.error || liveQuery.count === null) return null;
  const data = liveQuery.data as unknown as LiveMetadataRow[];
  const presentIds = new Set(data.map((row) => row.id));
  const missingQueuedIds = Object.entries(turns)
    .filter(([id, state]) => state === "queued" && !presentIds.has(id))
    .map(([id]) => id);
  const stoppedRows = missingQueuedIds.length
    ? (((await liveMetadataQuery(supabase, organizationId).eq("status", "stopped").in("id", missingQueuedIds)).data ??
        []) as unknown as LiveMetadataRow[])
    : [];
  const wakingRows = stoppedRows.filter((row) =>
    isSandboxWorking(row.status, turns[row.id], row.expiresAt ?? null, now),
  );
  const combined = wakingRows.length
    ? [...data, ...wakingRows]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))
        .slice(0, INLINE_LIVE_LIMIT)
    : data;
  return {
    rows: combined.map((row) => toLiveSandbox(row, turns, now)),
    total: liveQuery.count + wakingRows.length,
  } satisfies LiveSandboxes;
}

export async function readLiveSandboxes(
  supabase: Supabase,
  organizationId: string,
  control?: ControlClient | null,
  now = new Date(),
) {
  const resolvedControl = await resolveControl(control);
  if ((await headers()).has(SANDBOX_INVENTORY_HEADER)) {
    try {
      const [{ inventory }, turns] = await Promise.all([
        listSandboxMetadata(organizationId),
        readRecordedTurns(organizationId, resolvedControl),
      ]);
      const live = inventory.filter(
        ({ id, status, canOpen, expiresAt }) =>
          canOpen && (LIVE_STATUSES.includes(status) || isSandboxWorking(status, turns[id], expiresAt, now)),
      );
      return {
        rows: sortSandboxes(live, "newest")
          .slice(0, INLINE_LIVE_LIMIT)
          .map((row) => toLiveSandbox(row, turns, now)),
        total: live.length,
      } satisfies LiveSandboxes;
    } catch {
      return null;
    }
  }
  return queryLiveSandboxes(supabase, organizationId, resolvedControl, now);
}

function toLiveSandbox(row: LiveMetadataRow, turns: Readonly<Record<string, RecordedTurn>>, now: Date) {
  return {
    id: row.id,
    label: sandboxListName(row),
    status: row.status,
    working: isSandboxWorking(row.status, turns[row.id], row.expiresAt ?? null, now),
  };
}
