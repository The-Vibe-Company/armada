import { expect, test } from "bun:test";
import { createServerRequestDrain } from "../src/server-request-drain.ts";

test("drain retains an admitted POST stream and refuses new work without dispatch", async () => {
  let calls = 0;
  const tracker = createServerRequestDrain(async () => {
    calls++;
    return new Response("event: result\ndata: done\n\n", {
      status: 201,
      headers: { "content-type": "text/event-stream", "x-fixture": "preserved" },
    });
  });
  const response = await tracker.fetch(new Request("https://server.test/mcp", { method: "POST" }));
  const drained = Promise.all([...tracker.requests]);
  let finished = false;
  void drained.then(() => {
    finished = true;
  });
  tracker.beginDrain();
  const refused = await tracker.fetch(new Request("https://server.test/new"));
  expect(refused.status).toBe(503);
  expect(refused.headers.get("retry-after")).toBe("5");
  expect(await refused.json()).toEqual({ error: "temporarily_unavailable" });
  expect(calls).toBe(1);
  expect(finished).toBe(false);
  expect(response.status).toBe(201);
  expect(response.headers.get("x-fixture")).toBe("preserved");
  expect(await response.text()).toBe("event: result\ndata: done\n\n");
  await drained;
  expect(finished).toBe(true);
});

test("idle GET notifications do not hold the request drain open", async () => {
  const tracker = createServerRequestDrain(async () => new Response(new ReadableStream<Uint8Array>()));
  const response = await tracker.fetch(new Request("https://server.test/mcp"));
  tracker.beginDrain();
  await Promise.all([...tracker.requests]);
  // MCP shutdown owns ending this notification stream, not the HTTP request drain.
  expect(response.body?.locked).toBe(false);
  await response.body?.cancel();
});
