import { describe, expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const token = "armada_sk_fixture_token";
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

describe("events through the Armada API", () => {
  test("writes one JSON line per event on a pipe and reads one default page", async () => {
    const calls: Request[] = [];
    const events = [
      { id: "a", at: 1, kind: "message", text: "hello\nworld" },
      { id: "b", at: 2, kind: "message", text: "done" },
    ];
    let out = "";
    const code = await run(
      ["events"],
      { out: (text) => (out += text), err: () => undefined },
      {
        stdoutIsTTY: false,
        auth: {
          ...auth(async (input, init) => {
            calls.push(new Request(String(input), init));
            return Response.json({ events, cursor: "next", hasMore: true, settled: false });
          }),
          env: { ARMADA_TOKEN: token, ARMADA_SANDBOX: id },
        },
      },
    );
    expect(code).toBe(0);
    expect(
      out
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(events);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://armada.thevibecompany.co/api/v1/logs/read");
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(await calls[0]?.json()).toEqual({ id, follow: false });
  });

  test.each([false, true])("carries the API cursor across follow batches (tail=%s)", async (tail) => {
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
      ["events", id, "-f", ...(tail ? ["--tail", "2"] : [])],
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
      { id, follow: true, ...(tail ? { direction: "backward", limit: 2 } : {}) },
      { id, follow: true, cursor: "one" },
      { id, follow: true, cursor: "two" },
    ]);
  });

  test("drains follow backlog before accepting a terminal settled response", async () => {
    const bodies: unknown[] = [];
    let out = "";
    const batches = [
      { events: [{ id: "first", at: 1, kind: "message", text: "first" }], cursor: "one", hasMore: true, settled: true },
      {
        events: [{ id: "second", at: 2, kind: "message", text: "second" }],
        cursor: "two",
        hasMore: false,
        settled: true,
      },
    ];
    const code = await run(
      ["events", id, "-f"],
      { out: (text) => (out += text), err: () => undefined },
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
    expect(out).toBe("first\nsecond\n");
    expect(bodies).toEqual([
      { id, follow: true },
      { id, follow: true, cursor: "one" },
    ]);
  });

  test("rejects a draining response that has more events without a new cursor", async () => {
    let err = "";
    const code = await run(
      ["events", id, "--follow"],
      { out: () => undefined, err: (text) => (err += text) },
      {
        auth: auth(async () => Response.json({ events: [], cursor: null, hasMore: true, settled: true })),
      },
    );
    expect(code).toBe(1);
    expect(err).toContain("did not advance its cursor");
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
      ["events", id, "-f"],
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
      { id, follow: true },
      { id, follow: true, cursor: "one" },
      { id, follow: true, cursor: "one" },
    ]);
  });
});

test.each(["explicit", "saved"])("events forwards the %s organization selection", async (selection) => {
  const saved = "22222222-2222-4222-8222-222222222222";
  const explicit = "33333333-3333-4333-8333-333333333333";
  let body: unknown;
  const api = auth(async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ events: [], cursor: null, hasMore: false, settled: true });
  });
  const code = await run(
    ["events", id, ...(selection === "explicit" ? ["--org", explicit] : []), "--json"],
    { out: () => {}, err: () => {} },
    { auth: { ...api, preferences: { read: async () => saved, write: async () => {} } } },
  );
  expect(code).toBe(0);
  expect(body).toEqual({ id, follow: false, org: selection === "explicit" ? explicit : saved });
});

test("events accepts logs/read receipts with optional settled omitted", async () => {
  let out = "";
  const code = await run(
    ["events", id],
    { out: (text) => (out += text), err: () => {} },
    {
      auth: auth(async () =>
        Response.json({ events: [{ id: "e1", at: 1, kind: "message", text: "hi" }], cursor: null, hasMore: false }),
      ),
    },
  );
  expect(code).toBe(0);
  expect(out).toBe("hi\n");
});

test("logs is an unknown command", async () => {
  let stderr = "";
  const code = await run(["logs"], { out: () => {}, err: (text) => (stderr += text) }, { env: {} });
  expect(code).toBe(2);
  expect(stderr).toContain("unknown command 'logs'");
});

test("events -f streams live events over SSE without sleep polling and preserves same-id updates", async () => {
  const calls: string[] = [];
  let sleeps = 0,
    out = "";
  const frame = (frameId: string, body: Record<string, unknown>) =>
    `id: ${frameId}\ndata: ${JSON.stringify({ id: frameId, sandboxId: id, ref: String(body.sequence ?? "1"), createdAt: "2026-11-20T00:00:00.000Z", ...body })}\n\n`;
  const sse =
    frame("10", {
      kind: "runtime_event",
      sequence: "1",
      event: { id: "e1", at: 1, kind: "message", text: "initial" },
    }) +
    frame("11", {
      kind: "runtime_event",
      sequence: "2",
      event: { id: "e1", at: 2, kind: "message", text: "live update", partial: false, tools: [] },
    }) +
    frame("12", { kind: "transition", sequence: null, status: "stopped" });
  const code = await run(
    ["events", id, "-f"],
    { out: (t) => (out += t), err: () => {} },
    {
      auth: auth(async (input) => {
        const url = new URL(String(input));
        calls.push(url.pathname + url.search);
        return url.pathname === "/api/v1/logs/read"
          ? Response.json({
              events: [{ id: "e1", at: 1, kind: "message", text: "initial" }],
              cursor: "1",
              hasMore: false,
              settled: false,
            })
          : new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }),
      sleep: async () => {
        sleeps++;
      },
    },
  );
  expect([code, sleeps, out]).toEqual([0, 0, "initial\nlive update\n"]);
  expect(calls).toEqual([`/api/v1/events?sandbox=${id}&cursor=tail`, "/api/v1/logs/read"]);
});

test("events formats tool_use and tool_result concisely in TTY mode while keeping --json as NDJSON", async () => {
  const large = "x".repeat(300);
  const sample = [
    {
      id: "t1",
      at: 1,
      kind: "message",
      text: "",
      partial: false,
      tools: [{ id: "c1", name: "Bash", input: { command: "git status" } }],
    },
    {
      id: "t2",
      at: 2,
      kind: "message",
      text: "",
      partial: false,
      responseKind: "tool_result",
      tools: [{ id: "c1", name: "tool_result", result: { output: large, isError: false } }],
    },
    { id: "t3", at: 3, kind: "other", type: "tool_use", data: { name: "Read", input: { file_path: "src/index.ts" } } },
    { id: "t4", at: 4, kind: "other", type: "tool_result", data: { output: "boom", isError: true } },
  ];
  let ttyOut = "",
    jsonOut = "";
  const fetchEvents = async () => Response.json({ events: sample, cursor: null, hasMore: false, settled: true });
  expect(
    await run(
      ["events", id],
      { out: (t) => (ttyOut += t), err: () => {} },
      { stdoutIsTTY: true, auth: auth(fetchEvents) },
    ),
  ).toBe(0);
  expect(ttyOut).toContain("[tool Bash] git status\n");
  expect(ttyOut).toContain("[tool_result] ");
  expect(ttyOut).not.toContain(large);
  expect(ttyOut).toContain("[tool Read] src/index.ts\n");
  expect(ttyOut).toContain("[tool_result error] boom\n");
  expect(
    await run(["events", id, "--json"], { out: (t) => (jsonOut += t), err: () => {} }, { auth: auth(fetchEvents) }),
  ).toBe(0);
  expect(
    jsonOut
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual(sample);
});
