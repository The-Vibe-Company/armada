import { expect, test } from "bun:test";
import { cliFetch } from "../src/http.ts";

test("the CLI closes connections after each response so idle polls cannot reuse a stale socket", async () => {
  let seen: RequestInit | undefined;
  const transport = cliFetch(async (_url, init) => {
    seen = init;
    return Response.json({ ok: true });
  });
  const headers = new Headers({ Authorization: "synthetic", Connection: "keep-alive" });
  await transport("https://api.example.test/", { method: "POST", headers, body: "query" });
  expect(new Headers(seen?.headers).get("connection")).toBe("close");
  expect(new Headers(seen?.headers).get("authorization")).toBe("synthetic");
  expect(seen?.body).toBe("query");
  expect(headers.get("connection")).toBe("keep-alive");
});
