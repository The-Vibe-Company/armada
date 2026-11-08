import { describe, expect, test } from "bun:test";
import { memorySessionStore } from "@armada/auth";
import { run } from "../src/run.ts";

const token = "armada_sk_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12";
const id = "11111111-1111-4111-8111-111111111111";

function auth(fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return {
    out: () => undefined,
    err: () => undefined,
    env: { ARMADA_TOKEN: token },
    fetch,
    now: () => new Date(),
    open: () => undefined,
    session: memorySessionStore(),
  };
}

describe("logs through the Armada API", () => {
  test("uses a token-only clean HOME and preserves --all", async () => {
    const calls: Request[] = [];
    let out = "";
    const code = await run(
      ["logs", id, "--all"],
      { out: (text) => (out += text), err: () => undefined },
      {
        auth: auth(async (input, init) => {
          const request = input instanceof Request ? input : new Request(String(input), init);
          calls.push(request);
          return Response.json({
            events: [{ id: "event", at: 1, kind: "message", text: "hello" }],
            cursor: null,
            hasMore: false,
            settled: true,
          });
        }),
      },
    );
    expect(code).toBe(0);
    expect(out).toBe("hello\n");
    expect(calls[0]?.url).toBe("https://armada.thevibecompany.co/api/v1/logs/read");
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(await calls[0]?.json()).toEqual({ id, all: true, follow: false });
  });

  test("keeps requesting follow until the server reports settled", async () => {
    const bodies: unknown[] = [];
    let calls = 0;
    let sleeps = 0;
    const code = await run(
      ["logs", id, "--follow", "--json"],
      { out: () => undefined, err: () => undefined },
      {
        auth: auth(async (input, init) => {
          const request = input instanceof Request ? input : new Request(String(input), init);
          bodies.push(await request.json());
          calls += 1;
          return Response.json({ events: [], cursor: null, hasMore: false, settled: calls === 2 });
        }),
        sleep: async () => {
          sleeps += 1;
        },
      },
    );
    expect(code).toBe(0);
    expect(calls).toBe(2);
    expect(sleeps).toBe(1);
    expect(bodies).toEqual([
      { id, all: false, follow: true },
      { id, all: false, follow: true },
    ]);
  });
});
