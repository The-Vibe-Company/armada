import { describe, expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

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

  test("carries the API cursor across follow batches and emits each event once", async () => {
    const bodies: unknown[] = [];
    let out = "";
    let sleeps = 0;
    const batches = [
      {
        events: [{ id: "first", at: 1, kind: "message", text: "first" }],
        cursor: "one",
        hasMore: false,
        settled: false,
      },
      {
        events: [{ id: "second", at: 2, kind: "message", text: "second" }],
        cursor: "two",
        hasMore: false,
        settled: false,
      },
      { events: [], cursor: "two", hasMore: false, settled: true },
    ];
    const code = await run(
      ["logs", id, "--follow"],
      { out: (text) => (out += text), err: () => undefined },
      {
        auth: auth(async (input, init) => {
          const request = input instanceof Request ? input : new Request(String(input), init);
          bodies.push(await request.json());
          const batch = batches.shift();
          if (!batch) throw new Error("unexpected request");
          return Response.json(batch);
        }),
        sleep: async () => {
          sleeps += 1;
        },
      },
    );
    expect(code).toBe(0);
    expect(out).toBe("first\nsecond\n");
    expect(sleeps).toBe(2);
    expect(bodies).toEqual([
      { id, all: false, follow: true },
      { id, all: false, follow: true, cursor: "one" },
      { id, all: false, follow: true, cursor: "two" },
    ]);
  });

  test("uses the returned cursor when --all drains server batches", async () => {
    const bodies: unknown[] = [];
    let out = "";
    const batches = [
      {
        events: [{ id: "first", at: 1, kind: "message", text: "first" }],
        cursor: "one",
        hasMore: true,
        settled: true,
      },
      {
        events: [{ id: "second", at: 2, kind: "message", text: "second" }],
        cursor: "two",
        hasMore: false,
        settled: true,
      },
    ];
    const code = await run(
      ["logs", id, "--all"],
      { out: (text) => (out += text), err: () => undefined },
      {
        auth: auth(async (input, init) => {
          const request = input instanceof Request ? input : new Request(String(input), init);
          bodies.push(await request.json());
          const batch = batches.shift();
          if (!batch) throw new Error("unexpected request");
          return Response.json(batch);
        }),
      },
    );
    expect(code).toBe(0);
    expect(out).toBe("first\nsecond\n");
    expect(bodies).toEqual([
      { id, all: true, follow: false },
      { id, all: true, follow: false, cursor: "one" },
    ]);
  });

  test("stops a non-follow read when a malformed batch does not advance its cursor", async () => {
    const bodies: unknown[] = [];
    const code = await run(
      ["logs", id, "--all"],
      { out: () => undefined, err: () => undefined },
      {
        auth: auth(async (input, init) => {
          const request = input instanceof Request ? input : new Request(String(input), init);
          bodies.push(await request.json());
          return Response.json({ events: [], cursor: null, hasMore: true, settled: true });
        }),
      },
    );
    expect(code).toBe(0);
    expect(bodies).toEqual([{ id, all: true, follow: false }]);
  });

  test("retains the last cursor through an empty in-progress delta", async () => {
    const bodies: unknown[] = [];
    const batches = [
      {
        events: [{ id: "first", at: 1, kind: "message", text: "first" }],
        cursor: "one",
        hasMore: false,
        settled: false,
      },
      { events: [], cursor: null, hasMore: false, settled: false },
      { events: [], cursor: "two", hasMore: false, settled: true },
    ];
    const code = await run(
      ["logs", id, "--follow"],
      { out: () => undefined, err: () => undefined },
      {
        auth: auth(async (input, init) => {
          const request = input instanceof Request ? input : new Request(String(input), init);
          bodies.push(await request.json());
          const batch = batches.shift();
          if (!batch) throw new Error("unexpected request");
          return Response.json(batch);
        }),
        sleep: async () => undefined,
      },
    );
    expect(code).toBe(0);
    expect(bodies).toEqual([
      { id, all: false, follow: true },
      { id, all: false, follow: true, cursor: "one" },
      { id, all: false, follow: true, cursor: "one" },
    ]);
  });
});
