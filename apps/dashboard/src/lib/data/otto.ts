import { mcpUrl } from "@/lib/env";
import { type OttoRead, readOtto } from "@/lib/otto";
import { selectedOrganization } from "./selected-org";
import { requireViewer } from "./viewer";

export type OttoPageData =
  | { state: "no-org" }
  | { state: "not-configured" }
  | { state: "read"; viewerId: string; read: OttoRead };

/** The Otto views of the selected organization, read as the signed-in member: the server rechecks membership. */
export async function loadOtto(): Promise<OttoPageData> {
  const [viewer, selected] = await Promise.all([requireViewer(), selectedOrganization()]);
  if (!selected) return { state: "no-org" };
  const url = mcpUrl();
  if (!url || !viewer.token) return { state: "not-configured" };
  return {
    state: "read",
    viewerId: viewer.id,
    read: await readOtto({ serverUrl: url, token: viewer.token, orgId: selected.org.id }),
  };
}
