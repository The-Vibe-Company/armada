import { readViewer } from "@/lib/data/viewer";
import { forwardControl, forwardControlGet } from "./control-proxy.ts";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forwardControl(request, path);
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forwardControlGet(request, path, readViewer);
}

export async function DELETE(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forwardControl(request, path);
}
