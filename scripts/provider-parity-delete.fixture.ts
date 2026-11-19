import { expect } from "bun:test";

export const sandboxDeletePath = "sandboxes/{id}";

export function parityRequest(url: string, init: RequestInit) {
  const target = new URL(url);
  const path = target.pathname.slice("/api/v1/".length);
  const match = /^sandboxes\/([^/]+)$/.exec(path);
  if (init.method === "DELETE" && match) {
    expect(init.body).toBeUndefined();
    return {
      path: sandboxDeletePath,
      body: {
        id: decodeURIComponent(match[1]!),
        org: target.searchParams.get("org"),
        request_id: target.searchParams.get("requestId"),
      },
    };
  }
  return { path, body: JSON.parse(String(init.body)) };
}
