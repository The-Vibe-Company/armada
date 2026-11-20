import { expect, test } from "bun:test";
import { createSandboxEventReader } from "./sandbox-event-stream.ts";

const sandboxId = "11111111-1111-4111-8111-111111111111";

function frame(id: string) {
  const reference = { id, sandboxId, sequence: id, kind: "runtime_event", ref: id, createdAt: "2026-11-20T10:00:00Z" };
  return `id: ${id}\ndata: ${JSON.stringify(reference)}\n\n`;
}

test("reconnects after the last applied frame and drains replayed references once", async () => {
  const first = "9007199254740992";
  const next = "9007199254740993";
  const replies = [
    [": connected\n\n", frame(first).slice(0, 10), frame(first).slice(10), frame(next)],
    [frame(first) + frame(next)],
    [],
  ];
  const headers: (string | null)[] = [];
  const signal = new AbortController().signal;
  const read = createSandboxEventReader(sandboxId, async (input, init) => {
    expect(input).toBe(`/api/v1/events?sandbox=${sandboxId}`);
    expect(init?.signal).toBe(signal);
    headers.push(new Headers(init?.headers).get("last-event-id"));
    const encoder = new TextEncoder();
    const chunks = replies.shift()!;
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  let attempts = 0;
  const apply = async () => ++attempts !== 2;
  const progressed = () => {};
  await read(signal, apply, progressed);
  await read(signal, apply, progressed);
  await read(signal, apply, progressed);
  expect(headers).toEqual([null, first, next]);
  expect(attempts).toBe(3);
});
