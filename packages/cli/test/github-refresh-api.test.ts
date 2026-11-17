import { expect, test } from "bun:test";
import { GITHUB_REFRESH_MODAL_NATIVE } from "@armada/core";
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

test.each([
  [GITHUB_REFRESH_MODAL_NATIVE, GITHUB_REFRESH_MODAL_NATIVE],
  ["untrusted response", "GitHub refresh is not supported for this sandbox's provider or runtime."],
])("GitHub refresh names an unsupported provider instead of a generic sandbox failure", async (message, expected) => {
  let error = "";
  const io = {
    out: () => {},
    err: (text: string) => {
      error += text;
    },
  };
  const code = await run(["github", "refresh", "sandbox-id", "--json"], io, {
    auth: {
      ...io,
      env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture-service-token" },
      session: memorySessionStore(),
      now: () => new Date(),
      open: () => {},
      fetch: async () => Response.json({ error: { code: "unsupported", message } }, { status: 400 }),
    },
  });
  expect(code).toBe(1);
  const failure = JSON.parse(error).error;
  expect(failure.message).toStartWith(expected);
  expect(failure.message).not.toContain("untrusted response");
  expect(failure.message).not.toContain("Sandbox operation failed");
});
