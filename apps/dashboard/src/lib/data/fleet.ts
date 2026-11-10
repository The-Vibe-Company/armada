import type { Sandbox } from "@armada/core";
import { readLogPages } from "@/lib/events";
import { type FleetRow, fleetRow, onBoard, summarizeEvents, type TurnSummary } from "@/lib/fleet";
import { GatewayError } from "@/lib/gateway";
import type { Supabase } from "@/lib/supabase/server";
import { viewerGateway } from "./gateway";
import { listGoldenHistory } from "./goldens";
import { selectedOrganization } from "./selected-org";
import type { Viewer } from "./viewer";

/** The most rows the board reads; each costs a read of its events. */
export const BOARD_LIMIT = 25;

export type Board = { rows: FleetRow[]; configured: boolean; capped: boolean };

/**
 * The board of the selected organization. The rows are the raw `sandboxes` read as the signed-in user, so row level
 * security keeps exactly those the viewer may open (their own, or every one for an admin). The events come from the
 * Armada server with the viewer's own session, which checks the same rule again; a row whose events cannot be read
 * is shown from its status.
 */
export async function readBoard(supabase: Supabase, viewer: Viewer, now: Date): Promise<Board> {
  const selected = await selectedOrganization();
  if (!selected) return { rows: [], configured: false, capped: false };
  const [{ data, error }, goldens] = await Promise.all([
    supabase
      .from("sandboxes")
      .select("*")
      .eq("org_id", selected.org.id)
      .neq("status", "deleted")
      .order("created_at", { ascending: false })
      .limit(BOARD_LIMIT * 2),
    listGoldenHistory(supabase),
  ]);
  if (error) throw new Error(error.message);
  const sandboxes = (data as Sandbox[]).filter((row) =>
    onBoard({ status: row.status, stoppedAt: row.stopped_at }, now),
  );
  const shown = sandboxes.slice(0, BOARD_LIMIT);
  const gateway = viewerGateway(viewer);
  const turns = await Promise.all(
    shown.map(async (row): Promise<TurnSummary | null> => {
      if (!gateway) return null;
      try {
        return summarizeEvents((await readLogPages(gateway.logs, row.id, null)).events);
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
    capped: sandboxes.length > BOARD_LIMIT || (data?.length ?? 0) === BOARD_LIMIT * 2,
  };
}
