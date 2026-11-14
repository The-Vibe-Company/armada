import type { OttoObjective, OttoObjectiveMessage } from "@armada/core";
import { mcpUrl } from "@/lib/env";
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
  const url = new URL(`/api/v1/otto/objectives${path}`, server);
  url.searchParams.set("org_id", orgId);
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${viewer.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new ObjectiveError(response.status);
  return response.json();
}

export type ObjectiveList = { items: OttoObjective[]; repositories: string[] };
export type ObjectiveThread = { objective: OttoObjective; messages: OttoObjectiveMessage[] };
