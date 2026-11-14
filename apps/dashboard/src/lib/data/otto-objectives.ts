import type { OttoObjective, OttoObjectiveMessage } from "@armada/core";
import { mcpUrl } from "@/lib/env";
import { ottoRequest } from "../otto-request";
import { selectedOrganization } from "./selected-org";
import { requireViewer } from "./viewer";

export class ObjectiveError extends Error {
  constructor(public status: number) {
    super(status === 404 ? "Objective not found in this organization." : "Objectives are unavailable. Try again.");
  }
}

/** Every read and write uses the current member's session; no dashboard service credential. */
export async function objectiveRequest<T>(orgId: string, path = "", body?: unknown): Promise<T> {
  const [viewer, selected] = await Promise.all([requireViewer(), selectedOrganization()]);
  const server = mcpUrl();
  if (selected?.org.id !== orgId || !server || !viewer.token) throw new ObjectiveError(403);
  const { response, body: result } = await ottoRequest({
    serverUrl: server,
    token: viewer.token,
    orgId,
    path: `objectives${path}`,
    ...(body === undefined ? {} : { body }),
  });
  if (!response.ok) throw new ObjectiveError(response.status);
  return result as T;
}

export type ObjectiveList = { items: OttoObjective[]; repositories: string[] };
export type ObjectiveThread = { objective: OttoObjective; messages: OttoObjectiveMessage[] };
