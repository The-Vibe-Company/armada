import { expect, test } from "bun:test";
import { ottoRequest } from "../src/lib/otto-request.ts";

test("Otto transport scopes requests, refuses redirects, and preserves server status for callers", async () => {
  const { response, body } = await ottoRequest({
    serverUrl: "https://armada.example/subpath",
    token: "dashboard_session",
    orgId: "org_id",
    path: "objectives",
    body: { request: "Do work" },
    fetch: (async (input, init) => {
      expect(String(input)).toBe("https://armada.example/api/v1/otto/objectives?org_id=org_id");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.cache).toBe("no-store");
      expect(init?.headers).toEqual({ authorization: "Bearer dashboard_session", "content-type": "application/json" });
      expect(init?.body).toBe('{"request":"Do work"}');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ error: "forbidden" }, { status: 403 });
    }) as typeof fetch,
  });
  expect(response.status).toBe(403);
  expect(body).toEqual({ error: "forbidden" });
});
