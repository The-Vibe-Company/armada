import { selectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { ottoRequest } from "@/lib/otto-request";
export async function waitRequest<T>(orgId: string, path = "", body?: unknown): Promise<T> {
  const [viewer, selected] = await Promise.all([requireViewer(), selectedOrganization()]);
  const server = mcpUrl();
  if (selected?.org.id !== orgId || !server || !viewer.token) throw new Error("Waits unavailable");
  const result = await ottoRequest({
    serverUrl: server,
    token: viewer.token,
    orgId,
    path: `waits${path}`,
    ...(body === undefined ? {} : { body }),
  });
  if (!result.response.ok) throw new Error("Waits unavailable");
  return result.body as T;
}
