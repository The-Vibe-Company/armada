import { controlRouteKey, streamSandboxEvents } from "@armada/core/contract";
import { readViewer } from "@/lib/data/viewer";
import { forwardControl, forwardDashboardEventStream } from "./control-proxy.ts";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forwardControl(request, path);
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (path.length !== 1 || path[0] !== controlRouteKey(streamSandboxEvents.route)) {
    return forwardControl(request, path);
  }
  const viewer = await readViewer();
  if (!viewer?.token) {
    return Response.json(
      { error: { code: "unauthorized", message: "Sign in again." } },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    );
  }

  return forwardDashboardEventStream(request, viewer.token);
}

export async function DELETE(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forwardControl(request, path);
}
