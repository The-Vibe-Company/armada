import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const CONTROL_PREFIX = "/api/v1/";
const MAX_BODY_BYTES = 128 * 1024;

/** Server-side, same-origin forwarding to the configured Armada control API. */
export async function forwardControl(
  request: Request,
  path: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const upstream = controlOrigin(process.env.ARMADA_MCP_URL);
  if (!upstream) return NextResponse.json({ error: "Armada API is not configured." }, { status: 503 });
  const relative = path.join("/");
  if (!safePath(relative)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const authorization = request.headers.get("authorization");
  if (!authorization) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Request too large." }, { status: 413 });
  let response: Response;
  try {
    response = await fetchImpl(new URL(`${CONTROL_PREFIX}${relative}`, upstream), {
      method: "POST",
      headers: {
        authorization,
        "content-type": request.headers.get("content-type") ?? "application/json",
        accept: "application/json",
      },
      ...(body ? { body } : {}),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(300_000),
    });
  } catch {
    return NextResponse.json({ error: "Armada API is unavailable." }, { status: 502 });
  }
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forwardControl(request, path);
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (path.join("/") !== "auth/authorize") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const upstream = controlOrigin(process.env.ARMADA_MCP_URL);
  if (!upstream) return NextResponse.json({ error: "Armada API is not configured." }, { status: 503 });
  const target = new URL(`${CONTROL_PREFIX}auth/authorize`, upstream);
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

function controlOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function safePath(path: string): boolean {
  return (
    path === "auth/refresh" ||
    path === "auth/exchange" ||
    path === "auth/email/start" ||
    path === "auth/email/verify" ||
    path === "token/list" ||
    path === "token/create" ||
    path === "token/revoke" ||
    path === "golden/list" ||
    path === "golden/create" ||
    path === "golden/update" ||
    path === "golden/snapshot" ||
    path === "golden/connect" ||
    path === "sandbox/launch" ||
    path === "logs/read"
  );
}
