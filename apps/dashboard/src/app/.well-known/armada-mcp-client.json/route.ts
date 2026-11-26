import type { NextRequest } from "next/server";
import { mcpUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

const UPSTREAM_PATH = "/.well-known/armada-mcp-client.json";
const UPSTREAM_TIMEOUT_MS = 10_000;

function unavailable() {
  return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
}

function upstreamOrigin(value: string | null) {
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

function isValidClientMetadata(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.client_id === "string" &&
    record.client_id.length > 0 &&
    Array.isArray(record.redirect_uris) &&
    record.redirect_uris.length > 0 &&
    record.redirect_uris.every((uri) => typeof uri === "string" && uri.length > 0)
  );
}

export async function GET(request: NextRequest) {
  if (request.nextUrl.search !== "" || request.url.includes("?")) {
    return new Response(null, { status: 404 });
  }
  const origin = upstreamOrigin(mcpUrl());
  if (!origin) return unavailable();

  let upstream: Response;
  try {
    const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    upstream = await fetch(`${origin}${UPSTREAM_PATH}`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal,
    });
  } catch {
    return unavailable();
  }
  if (upstream.status !== 200) {
    void upstream.body?.cancel().catch(() => {});
    return unavailable();
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return unavailable();
  }
  if (!isValidClientMetadata(body)) return unavailable();

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    },
  });
}
