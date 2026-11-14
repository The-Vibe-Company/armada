import { expect, test } from "bun:test";
import { Journal } from "../src/journal.ts";
import { AUTH_HEADER } from "../src/protocol.ts";
import { Runner } from "../src/runtime.ts";

const grant = {
  token: "fixture-runtime-token",
  sandboxId: "logical",
  generation: "g1",
  expiresAt: Date.now() + 60_000,
};

test("runtime refuses streaming overflow without draining or waiting on cancellation", async () => {
  const journal = new Journal(":memory:", (text) => text);
  const runner = new Runner(journal, grant, {});
  let pulls = 0;
  let cancelled = false;
  const request = new Request("https://runtime.test/v1", {
    method: "POST",
    headers: { [AUTH_HEADER]: grant.token, "content-length": "1" },
    body: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          if (pulls === 1) controller.enqueue(new Uint8Array(1048576));
          else if (pulls === 2) controller.enqueue(new Uint8Array(1));
          else controller.error(new Error("must_not_drain_oversized_body"));
        },
        cancel() {
          cancelled = true;
          return new Promise(() => {});
        },
      },
      { highWaterMark: 0 },
    ),
  });
  try {
    const response = await runner.handle(request);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "request_too_large" });
    expect(pulls).toBe(2);
    expect(cancelled).toBe(true);
    expect(request.body?.locked).toBe(false);
  } finally {
    await runner.close();
    journal.close();
  }
});

test("runtime accepts an exact byte-limit body with UTF-8 split across chunks", async () => {
  const journal = new Journal(":memory:", (text) => text);
  const runner = new Runner(journal, grant, {});
  const json = JSON.stringify({ version: 1, sandboxId: grant.sandboxId, requestId: "é🙂", op: "health" });
  const encoder = new TextEncoder();
  const bytes = encoder.encode(json + " ".repeat(1048576 - encoder.encode(json).byteLength));
  const split = encoder.encode(json.slice(0, json.indexOf("🙂"))).byteLength + 1;
  const request = new Request("https://runtime.test/v1", {
    method: "POST",
    headers: { [AUTH_HEADER]: grant.token },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    }),
  });
  try {
    const response = await runner.handle(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 1, requestId: "é🙂" });
    expect(request.body?.locked).toBe(false);
  } finally {
    await runner.close();
    journal.close();
  }
});
