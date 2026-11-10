import type { Sandbox, SandboxStatus } from "@armada/core";
import { parseEventPage } from "@/lib/events";
import { type FleetRow, fleetRow, onBoard, summarizeEvents, type TurnSummary } from "@/lib/fleet";
import { GatewayError } from "@/lib/gateway";
import type { Supabase } from "@/lib/supabase/server";
import { viewerGateway } from "./gateway";
import { listGoldenHistory } from "./goldens";
import { selectedOrganization } from "./selected-org";
import type { Viewer } from "./viewer";

/** The most rows the board reads; each costs a read of its events. */
export const BOARD_LIMIT = 25;

/** Events per page of the one `logs` call a row costs; the server bounds the pages it reads in that call. */
const LOG_PAGE_SIZE = 500;

const LIVE = ["starting", "ready", "running", "stopping"] as const;
const ENDED = ["stopped", "failed"] as const;

export type Board = { rows: FleetRow[]; configured: boolean; capped: boolean };

/**
 * The board of the selected organization. The rows are the raw `sandboxes` read as the signed-in user, so row level
 * security keeps exactly those the viewer may open (their own, or every one for an admin). Live sandboxes come first
 * and recently ended ones fill what is left, so old stopped rows never push a live one off the board. The events
 * come from the Armada server with the viewer's own session, which checks the same rule again; a row whose events
 * cannot be read, or are longer than one bounded read, is shown from its status.
 */
export async function readBoard(supabase: Supabase, viewer: Viewer, now: Date): Promise<Board> {
  const selected = await selectedOrganization();
  if (!selected) return { rows: [], configured: false, capped: false };
  const query = (statuses: readonly SandboxStatus[]) =>
    supabase
      .from("sandboxes")
      .select("*")
      .eq("org_id", selected.org.id)
      .in("status", [...statuses])
      .order("created_at", { ascending: false })
      .limit(BOARD_LIMIT + 1);
  const [live, ended, goldens] = await Promise.all([query(LIVE), query(ENDED), listGoldenHistory(supabase)]);
  if (live.error) throw new Error(live.error.message);
  if (ended.error) throw new Error(ended.error.message);
  const candidates = [...(live.data as Sandbox[]), ...(ended.data as Sandbox[])].filter((row) =>
    onBoard(
      {
        status: row.status,
        stoppedAt: row.stopped_at,
        lastObservedAt: row.last_observed_at,
        createdAt: row.created_at,
      },
      now,
    ),
  );
  const shown = candidates.slice(0, BOARD_LIMIT);
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
  return {
    rows: shown.map((row, index) =>
      fleetRow(row, goldenById.get(row.golden_id) ?? null, turns[index] ?? null, viewer.id, now),
    ),
    configured: gateway !== null,
    capped: candidates.length > BOARD_LIMIT || live.data.length > BOARD_LIMIT || ended.data.length > BOARD_LIMIT,
  };
}
