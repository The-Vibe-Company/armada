import { createBoatProvider } from "../src/provider.ts";

export const KEY = "boat_test_key_not_real";

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A boat.dev stand-in at the HTTP boundary: it answers in order and records what the SDK really sent. */
export function fakeBoat(...replies: Reply[]) {
  const requests: Recorded[] = [];
  const queue = [...replies];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const text = typeof init?.body === "string" ? init.body : undefined;
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: text === undefined ? undefined : JSON.parse(text),
    });
    const reply = queue.shift();
    if (!reply) throw new Error(`Unexpected request ${init?.method} ${url.pathname}`);
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? { ok: true }), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  }) as typeof fetch;
  const sleeps: number[] = [];
  const provider = createBoatProvider({
    apiKey: KEY,
    fetch: fetchFake,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { provider, requests, sleeps, remaining: () => queue.length };
}

export function sandbox(overrides: Record<string, unknown> = {}) {
  return {
    id: "bx_23456789",
    name: "session-1",
    state: "provisioning",
    desktopAvailable: false,
    snapshotAvailable: false,
    createdAt: "2026-11-09T09:00:00Z",
    archiveAfter: "2026-11-09T10:00:00Z",
    labels: { armada: "1" },
    ...overrides,
  };
}

export function errorBody(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    status,
    body: {
      ok: false,
      type: "sandbox.error",
      status,
      code,
      message,
      error: { code, message, status, ...(details ? { details } : {}) },
      requestId: "req_test",
      ...extra,
    },
  };
}
