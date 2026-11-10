import type { SandboxStatus } from "@armada/core";
import { cookies } from "next/headers";
import { parseEventPage } from "@/lib/events";
import {
  ACK_COOKIE,
  type Board,
  buildBoard,
  ENDED_KEPT_MS,
  fleetRow,
  readAcks,
  summarizeEvents,
  type TurnSummary,
} from "@/lib/fleet";
import { GatewayError } from "@/lib/gateway";
import type { Supabase } from "@/lib/supabase/server";
import { viewerGateway } from "./gateway";
import { listGoldenHistory } from "./goldens";
import { selectedOrganization } from "./selected-org";
import type { Viewer } from "./viewer";

/**
 * Each kind of sandbox the board reads (live, failed, stopped holding something) is read at most this many at a time,
 * the newest first, so no kind crowds another out. Each row read costs a read of its events.
 */
const READ_LIMIT = 20;

/** Events per page of the one `logs` call a row costs; the server bounds the pages it reads in that call. */
const LOG_PAGE_SIZE = 500;

const LIVE: readonly SandboxStatus[] = ["starting", "ready", "running", "stopping"];

export type FleetBoard = Board & { configured: boolean; capped: boolean };

/**
 * The board of the selected organization. The rows are the raw `sandboxes` read as the signed-in user, so row level
 * security keeps exactly those the viewer may open (their own, or every one for an admin). It reads the live sandboxes,
 * the failures of the last day and the sandboxes stopped in the last day that hold an outcome or a preservation
 * receipt, each bounded on its own: a stopped sandbox with neither is never read, however many there are. The events come from
 * the Armada server with the viewer's own session, which checks the same rule again; a row whose events cannot be
 * read, or are longer than one bounded read, is shown from its status. The viewer's acknowledgements are a cookie.
 */
export async function readBoard(supabase: Supabase, viewer: Viewer, now: Date): Promise<FleetBoard> {
  const selected = await selectedOrganization();
  if (!selected) return { needs: [], working: [], all: [], configured: false, capped: false };
  const cutoff = new Date(now.getTime() - ENDED_KEPT_MS).toISOString();
  const rows = (status: SandboxStatus | readonly SandboxStatus[]) => {
    const base = supabase.from("sandboxes").select("*").eq("org_id", selected.org.id);
    return typeof status === "string" ? base.eq("status", status) : base.in("status", [...status]);
  };
  const [live, failed, stopped, goldens] = await Promise.all([
    rows(LIVE)
      .order("created_at", { ascending: false })
      .limit(READ_LIMIT + 1),
    rows("failed")
      .or(`stopped_at.gte.${cutoff},last_observed_at.gte.${cutoff},created_at.gte.${cutoff}`)
      .order("created_at", { ascending: false })
      .limit(READ_LIMIT + 1),
    rows("stopped")
      .gte("stopped_at", cutoff)
      .or("task_outcome.not.is.null,preservation_note.not.is.null")
      .order("stopped_at", { ascending: false })
      .limit(READ_LIMIT + 1),
    listGoldenHistory(supabase),
  ]);
  for (const read of [live, failed, stopped]) if (read.error) throw new Error(read.error.message);
  const candidates = [live.data ?? [], failed.data ?? [], stopped.data ?? []].flatMap((read) =>
    read.slice(0, READ_LIMIT),
  );
  const shown = candidates;
  const gateway = viewerGateway(viewer);
  const turns = await Promise.all(
    shown.map(async (row): Promise<TurnSummary | null> => {
      if (!gateway) return null;
      try {
        const page = parseEventPage(await gateway.logs(row.id, null, { all: true, limit: LOG_PAGE_SIZE }));
        // Past the server's bound the newest events are missing: the oldest would show a stale state.
        return page.hasMore ? null : summarizeEvents(page.events);
      } catch (cause) {
        if (cause instanceof GatewayError) return null;
        throw cause;
      }
    }),
  );
  const goldenById = new Map(goldens.map((golden) => [golden.id, golden]));
  const acknowledged = new Set(readAcks((await cookies()).get(ACK_COOKIE)?.value, viewer.id));
  const board = buildBoard(
    shown.map((row, index) =>
      fleetRow(row, goldenById.get(row.golden_id) ?? null, turns[index] ?? null, viewer.id, now),
    ),
    acknowledged,
  );
  return {
    ...board,
    configured: gateway !== null,
    capped: [live.data, failed.data, stopped.data].some((read) => (read?.length ?? 0) > READ_LIMIT),
  };
}
