import type { NextRequest } from "next/server";
import { selectedOrganization } from "@/lib/data/selected-org";
import { readViewer } from "@/lib/data/viewer";
import { readLiveSandboxes } from "@/lib/live-sandboxes";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  if (!(await readViewer())) return new Response(null, { status: 401 });
  const organization = await selectedOrganization();
  const requested = request.nextUrl.searchParams.get("organizationId");
  if (!organization || (requested !== null && organization.org.id !== requested)) {
    return new Response(null, { status: 409 });
  }
  const live = await readLiveSandboxes(await createClient(), organization.org.id);
  if (!live) return new Response(null, { status: 503 });
  return Response.json(live.rows, {
    headers: { "Cache-Control": "private, no-store", "X-Live-Count": String(live.total) },
  });
}
