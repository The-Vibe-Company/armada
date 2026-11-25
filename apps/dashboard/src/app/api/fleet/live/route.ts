import type { NextRequest } from "next/server";
import { createControlClient } from "@/lib/control";
import { selectedOrganization } from "@/lib/data/selected-org";
import { readViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { queryLiveSandboxes } from "@/lib/live-sandboxes";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const viewer = await readViewer();
  if (!viewer) return new Response(null, { status: 401 });
  const organization = await selectedOrganization();
  const requested = request.nextUrl.searchParams.get("organizationId");
  if (!organization || (requested !== null && organization.org.id !== requested)) {
    return new Response(null, { status: 409 });
  }
  const serverUrl = mcpUrl();
  const control = serverUrl && viewer.token ? createControlClient({ serverUrl, token: viewer.token }) : null;
  const live = await queryLiveSandboxes(await createClient(), organization.org.id, control);
  if (!live) return new Response(null, { status: 503 });
  return Response.json(live.rows, {
    headers: { "Cache-Control": "private, no-store", "X-Live-Count": String(live.total) },
  });
}
