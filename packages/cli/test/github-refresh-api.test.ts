import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

test.each([new Response("Not found", { status: 404 }), Response.json({ error: "Not found." }, { status: 404 })])(
  "GitHub refresh explains missing proxy/server routes without echoing response text",
  async (response) => {
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
    expect(error).toContain("This Armada deployment at https://armada.test does not serve /api/v1/github/refresh");
    expect(error).not.toContain("untrusted response");
  },
);

test("GitHub refresh distinguishes a server not_found from an undeployed route", async () => {
  let error = "";
  const code = await run(
    ["github", "refresh", "missing", "--json"],
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
        env: { ARMADA_TOKEN: "fixture-service-token" },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => {},
        fetch: async () =>
          Response.json({ error: { code: "not_found", message: "untrusted response" } }, { status: 404 }),
      },
    },
  );
  expect(code).toBe(1);
  expect(JSON.parse(error).error).toEqual({ code: "conflict", message: "Sandbox not found or not accessible." });
});
