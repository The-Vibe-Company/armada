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

test.each([
  [404, "not_found", "Sandbox not found or not accessible."],
  [403, "forbidden", "GitHub refresh requires current organization membership and the sandbox owner."],
] as const)(
  "GitHub refresh distinguishes a structured %s resource failure from an undeployed route",
  async (status, serverCode, message) => {
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
          fetch: async () => Response.json({ error: { code: serverCode, message: "untrusted response" } }, { status }),
        },
      },
    );
    expect(code).toBe(1);
    expect(JSON.parse(error).error).toEqual({ code: "conflict", message });
  },
);
