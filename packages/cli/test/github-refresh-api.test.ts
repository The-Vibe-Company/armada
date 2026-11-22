import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

test("the API escape hatch reports GitHub repair refusal without leaking a response body", async () => {
  let error = "";
  const io = {
    out: () => {
      throw new Error("A refused repair must not produce output");
    },
    err: (text: string) => {
      error += text;
    },
  };
  const code = await run(["api", "github/refresh", '{"id":"sandbox-id"}'], io, {
    auth: {
      ...io,
      env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture-service-token" },
      session: memorySessionStore(),
      now: () => new Date(0),
      open: () => {},
      fetch: async () =>
        Response.json({ error: { code: "forbidden", message: "untrusted response" } }, { status: 403 }),
    },
  });
  expect(code).toBe(1);
  expect(error).toContain("HTTP 403");
  expect(error).not.toContain("untrusted response");
});
