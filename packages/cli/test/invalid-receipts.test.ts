import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const id = "11111111-1111-4111-8111-111111111111";
const key = "22222222-2222-4222-8222-222222222222";
const commands = [
  ["stop", id],
  ["send", id, "hello", "--request-id", key],
  ["exec", id, "pwd"],
  ["wait", id],
  ["status", id],
  ["logs", id],
  ["snapshot", "list"],
  ["org", "list"],
];

test("invalid success receipts fail operationally before output, without replaying mutations", async () => {
  for (const command of commands) {
    for (const body of [
      "broken",
      "null",
      "[]",
      "{}",
      JSON.stringify({
        events: [
          {
            id: "event",
            at: 0,
            kind: "other",
            type: "armada/modelRateLimit",
            data: { message: "wait", retryCount: { toString: null }, totalWaitMs: 0 },
          },
        ],
        cursor: null,
        hasMore: false,
        settled: true,
      }),
      JSON.stringify({ id, status: ["stopped"] }),
      JSON.stringify({ id, status: { toString: null } }),
      JSON.stringify({ id, status: "unrecognized", prompt: null, settled: true }),
      JSON.stringify({ id, status: "ready", prompt: {}, settled: true }),
      '{"events":[{}],"cursor":null,"hasMore":false,"settled":true}',
      '{"goldens":[{"name":"web"}]}',
      '{"orgs":[null]}',
      '{"goldens":[{"name":"web","provider":{"toString":null},"config":{"repos":[]}}]}',
      '{"events":[null],"cursor":null,"hasMore":false,"settled":true}',
    ]) {
      let stdout = "",
        stderr = "",
        calls = 0;
      const auth = {
        env: { ARMADA_TOKEN: "fixture_session", ARMADA_URL: "https://armada.test" },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => {},
        out: (text: string) => {
          stdout += text;
        },
        err: (text: string) => {
          stderr += text;
        },
        fetch: async () => {
          calls++;
          return new Response(body, { status: 200 });
        },
      };
      const exit = await run([...command, "--json"], auth, { auth });
      expect(exit).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain('"code":"unavailable"');
      expect(stderr).toContain("before retrying");
      if (command[0] === "send") expect(stderr).toContain(key);
      expect(calls).toBe(1);
    }
  }
});
