import { expect, test } from "bun:test";
import { HttpRequestError, httpRequest } from "../src/http.ts";

const url = "https://api.example.test/read";
const timeout = () => new DOMException("timed out", "TimeoutError");

test("caller cancellation inside a transport wrapper is not retried as a deadline", async () => {
  const cancelled = new DOMException("cancelled", "AbortError");
  let calls = 0;
  const err = await httpRequest(
    url,
    {},
    {
      retry: true,
      fetch: async () => {
        calls++;
        throw cancelled;
      },
    },
    (res) => res.text(),
  ).catch((error) => error);
  expect(err).toBe(cancelled);
  expect(calls).toBe(1);
});

test("a safe read retries once with a fresh deadline, then returns the answer", async () => {
  const limits: number[] = [];
  const signals: AbortSignal[] = [];
  let calls = 0;
  const answer = await httpRequest(
    url,
    { method: "POST", body: "query" },
    {
      retry: true,
      timeoutSignal: (ms) => {
        limits.push(ms);
        return new AbortController().signal;
      },
      fetch: async (_url, init) => {
        signals.push(init.signal as AbortSignal);
        if (++calls === 1) throw timeout();
        return Response.json({ ok: true });
      },
    },
    (res) => res.json(),
  );
  expect(answer).toEqual({ ok: true });
  expect(calls).toBe(2);
  expect(limits).toEqual([5000, 10000]);
  expect(signals[0]).not.toBe(signals[1]);
  expect(signals[0]?.aborted).toBe(true);
});

test("exhausted safe reads name the deadline and retry, preserving shorter configured limits", async () => {
  const limits: number[] = [];
  const err = await httpRequest(
    url,
    {},
    {
      retry: true,
      timeoutMs: 400,
      timeoutSignal: (ms) => {
        limits.push(ms);
        return new AbortController().signal;
      },
      fetch: async () => {
        throw timeout();
      },
    },
    (res) => res.text(),
  ).catch((error) => error);
  expect(err).toBeInstanceOf(HttpRequestError);
  expect(err.message).toBe("no answer within 400 ms; failed after 2 attempts (one retry)");
  expect(limits).toEqual([400, 400]);
});

test("the deadline covers an unresponsive fetch and response body, even with an injected transport", async () => {
  for (const body of [false, true]) {
    let calls = 0;
    let reads = 0;
    let deadline = new AbortController();
    const err = await httpRequest(
      url,
      {},
      {
        retry: true,
        timeoutSignal: () => {
          deadline = new AbortController();
          return deadline.signal;
        },
        fetch: async () => {
          calls++;
          if (!body) queueMicrotask(() => deadline.abort(timeout()));
          return body ? new Response(new ReadableStream()) : new Promise<Response>(() => {});
        },
      },
      (res) => {
        reads++;
        const reading = res.text();
        queueMicrotask(() => deadline.abort(timeout()));
        return reading;
      },
    ).catch((error) => error);
    expect(calls).toBe(2);
    expect(reads).toBe(body ? 2 : 0);
    expect(err).toBeInstanceOf(HttpRequestError);
    expect(err.message).toContain("failed after 2 attempts");
  }
});

test("connection failures retry safe reads; unsafe requests and semantic errors are not replayed", async () => {
  for (const retry of [false, true]) {
    let calls = 0;
    await httpRequest(
      url,
      { method: "POST" },
      {
        retry,
        fetch: async () => {
          calls++;
          throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
        },
      },
      (res) => res.text(),
    ).catch(() => {});
    expect(calls).toBe(retry ? 2 : 1);
  }
  for (const status of [401, 403, 429, 503]) {
    let calls = 0;
    expect(
      await httpRequest(
        url,
        {},
        {
          retry: true,
          fetch: async () => {
            calls++;
            return new Response("refused", { status });
          },
        },
        async (res) => res.status,
      ),
    ).toBe(status);
    expect(calls).toBe(1);
  }
  let calls = 0;
  const semantic = new Error("invalid answer");
  const err = await httpRequest(
    url,
    {},
    {
      retry: true,
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    },
    async () => {
      throw semantic;
    },
  ).catch((error) => error);
  expect(err).toBe(semantic);
  expect(calls).toBe(1);
});
