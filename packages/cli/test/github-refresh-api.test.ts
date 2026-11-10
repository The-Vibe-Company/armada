import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

test.each([
  new Response("Not found", { status: 404 }),
  Response.json({ error: "Not found." }, { status: 404 }),
  Response.json({ error: { code: "not_found", message: "untrusted response" } }, { status: 404 }),
])("GitHub refresh explains missing proxy/server routes without echoing response text", async (response) => {
  let error = "";
  const code = await run(
    ["github", "refresh", "sandbox-id"],
    {
      out: () => {},
      err: (text) => {
        error += text;
      },
    },
    {
      auth: {
        out: () => {},
        err: (text) => {
          error += text;
        },
        env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture-service-token" },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => {},
        fetch: async () => response,
      },
    },
  );
  expect(code).not.toBe(0);
  expect(error).toContain("dashboard/server route is not deployed");
  expect(error).toContain("sandbox");
  expect(error).not.toContain("untrusted response");
});
