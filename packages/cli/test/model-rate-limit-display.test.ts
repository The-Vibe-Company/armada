import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

test.each(["info", "events"])("%s explains provider backoff in plain text", async (command) => {
  let output = "";
  let errors = "";
  const wait = { message: "Rate limited by the model provider, retrying in 20 s", retryCount: 2, totalWaitMs: 21_000 };
  const result =
    command === "info"
      ? {
          id: "11111111-1111-4111-8111-111111111111",
          status: "running",
          settled: false,
          prompt: {
            promptId: "prompt",
            conversationId: "conversation",
            state: "running",
            reason: null,
            rateLimit: wait,
          },
        }
      : {
          events: [{ id: "wait", at: 1000, kind: "other", type: "armada/modelRateLimit", data: wait }],
          cursor: null,
          hasMore: false,
          settled: true,
        };
  const code = await run(
    [command, "11111111-1111-4111-8111-111111111111"],
    {
      out: (text) => {
        output += text;
      },
      err: (text) => {
        errors += text;
      },
    },
    {
      auth: {
        out: (text) => {
          output += text;
        },
        err: (text) => {
          errors += text;
        },
        env: { ARMADA_TOKEN: "test_placeholder" },
        fetch: async () => Response.json(result),
        now: () => new Date(2000),
        open: () => {},
        session: memorySessionStore(),
      },
    },
  );
  expect(code).toBe(0);
  if (command === "info") {
    expect(errors).toContain("Rate limited by the model provider, retrying in 20 s (retry 2, total wait 21 s)");
    expect(JSON.parse(output)).toEqual(result);
  } else {
    expect(output).toContain("Rate limited by the model provider, retrying in 20 s (retry 2, total wait 21 s)");
  }
});
