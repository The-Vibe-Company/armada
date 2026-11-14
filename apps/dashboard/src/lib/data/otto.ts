import { mcpUrl } from "@/lib/env";
import { type OttoRead, readOtto } from "@/lib/otto";
import { selectedOrganization } from "./selected-org";
import { requireViewer } from "./viewer";

export type OttoPageData =
  | { state: "no-org" }
  | { state: "not-configured" }
  | { state: "read"; viewerId: string; repositories: string[]; repository: string | undefined; read: OttoRead };

/** The Otto views of the selected organization, read as the signed-in member: the server rechecks membership. */
export async function loadOtto(requested?: string): Promise<OttoPageData> {
  const [viewer, selected] = await Promise.all([requireViewer(), selectedOrganization()]);
  if (!selected) return { state: "no-org" };
  const url = mcpUrl();
  if (!url || !viewer.token) return { state: "not-configured" };
  let repositories: string[] = [];
  try {
    const endpoint = new URL("/api/v1/otto/repositories", url);
    endpoint.searchParams.set("org_id", selected.org.id);
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${viewer.token}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const body: unknown = await response.json();
    if (response.ok && typeof body === "object" && body !== null && "items" in body && Array.isArray(body.items))
      repositories = body.items.filter((item): item is string => typeof item === "string");
  } catch {
    /* Read failures remain explicit below. */
  }
  const repository = requested ?? repositories[0];
  return {
    state: "read",
    viewerId: viewer.id,
    repositories,
    repository,
    read: await readOtto({ serverUrl: url, token: viewer.token, orgId: selected.org.id, repository }),
  };
}
