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

test.each([600_000, 30_000, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
  "health exposes only a valid resolved idle delay (%s)",
  async (idlePauseDelayMs) => {
    for (const ready of [true, false]) {
      const handler = createHandler({ idlePauseDelayMs, ready: async () => ready } as HandlerOptions);
      const response = await handler(new Request("https://server.example/healthz"));
      const body = (await response.json()) as { ok: boolean; idlePauseDelayMs?: number };
      expect(response.status).toBe(ready ? 200 : 503);
      expect(body.idlePauseDelayMs).toBe(
        typeof idlePauseDelayMs === "number" && Number.isSafeInteger(idlePauseDelayMs) && idlePauseDelayMs > 0
          ? idlePauseDelayMs
          : undefined,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  },
);
