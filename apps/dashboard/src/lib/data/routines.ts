import { ControlError, createRoutineControl } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import { type RoutineItem, routineFailure } from "@/lib/routines";
import { selectedOrganization } from "./selected-org";
import { requireViewer } from "./viewer";

export async function viewerRoutines() {
  const viewer = await requireViewer(),
    url = mcpUrl();
  return url && viewer.token ? createRoutineControl({ serverUrl: url, token: viewer.token }) : null;
}
type RoutineList =
  | { state: "ready"; userId: string; items: RoutineItem[] }
  | { state: "no-org" | "not-configured" }
  | { state: "error" | "unsupported"; message: string };
export async function listSelectedRoutines(): Promise<RoutineList> {
  const [viewer, selected] = await Promise.all([requireViewer(), selectedOrganization()]);
  if (!selected) return { state: "no-org" };
  const control = await viewerRoutines();
  if (!control) return { state: "not-configured" };
  try {
    return {
      state: "ready",
      userId: viewer.id,
      items: (await control.list(selected.org.id)).filter((x) => x.scope === "org" || x.ownerId === viewer.id),
    };
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    const unsupported = error.status === 404 && (error.code === "unknown_route" || error.code === undefined);
    return {
      state: unsupported ? "unsupported" : "error",
      message: unsupported
        ? "This Armada server does not offer routines yet. Update it before scheduling."
        : routineFailure(error.status),
    };
  }
}
