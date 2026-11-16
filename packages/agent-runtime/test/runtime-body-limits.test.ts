import { expect, test } from "bun:test";
import { readRuntimeJson } from "../src/request-framing.ts";

test("runtime refuses streaming overflow without draining or waiting on cancellation", async () => {
  let pulls = 0;
  let cancelled = false;
  const request = new Request("https://runtime.test/v1", {
    method: "POST",
    headers: { "content-length": "1" },
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
  await expect(readRuntimeJson(request)).rejects.toThrow("request_too_large");
  expect(pulls).toBe(2);
  expect(cancelled).toBe(true);
  expect(request.body?.locked).toBe(false);
});

test("runtime accepts an exact byte-limit body with UTF-8 split across chunks", async () => {
  const json = JSON.stringify({ version: 1, sandboxId: "logical", requestId: "é🙂", op: "health" });
  const encoder = new TextEncoder();
  const bytes = encoder.encode(json + " ".repeat(1048576 - encoder.encode(json).byteLength));
  const split = encoder.encode(json.slice(0, json.indexOf("🙂"))).byteLength + 1;
  const request = new Request("https://runtime.test/v1", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    }),
  });
  expect(await readRuntimeJson(request)).toEqual(JSON.parse(json));
  expect(request.body?.locked).toBe(false);
});
