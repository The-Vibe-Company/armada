import { expect, test } from "bun:test";
import { createHandler, type HandlerOptions } from "../src/http.ts";

test.each(["a".repeat(40), undefined, "not-a-public-commit"])(
  "health exposes only a valid public deployment commit: %s",
  async (commitSha) => {
    // Health is intentionally independent of OAuth/database/provider dependencies.
    const handler = createHandler({ commitSha } as HandlerOptions);
    const response = await handler(new Request("https://server.example/healthz"));
    const body = (await response.json()) as { ok: boolean; commit?: string };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.commit).toBe(commitSha === "a".repeat(40) ? commitSha : undefined);
    expect(response.headers.get("cache-control")).toBe("no-store");
  },
);
