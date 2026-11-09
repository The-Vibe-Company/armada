import { NextResponse } from "next/server";
import { controlOrigin, forwardControl } from "./control-proxy.ts";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forwardControl(request, path);
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (path.join("/") !== "auth/authorize") return forwardControl(request, path);
  const upstream = controlOrigin(process.env.ARMADA_MCP_URL);
  if (!upstream) return NextResponse.json({ error: "Armada API is not configured." }, { status: 503 });
  const target = new URL("/api/v1/auth/authorize", upstream);
  target.search = new URL(request.url).search;
  try {
    const response = await fetch(target, { redirect: "manual", cache: "no-store" });
    const location = response.headers.get("location");
    if (response.status === 302 && location)
      return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
    return new Response(response.body, { status: response.status, headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Armada API is unavailable." }, { status: 502 });
  }
}
