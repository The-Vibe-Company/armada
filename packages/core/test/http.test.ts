import { expect, test } from "bun:test";
import { HttpRequestError, httpRequest, retryStatus } from "../src/http.ts";

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

test("status retries wait twice, drain failed responses, and leave exhaustion and unsafe POSTs to the reader", async () => {
  for (const statuses of [
    [503, 503, 200],
    [503, 503, 503],
  ]) {
    const waits: number[] = [];
    const notices: string[] = [];
    const responses: Response[] = [];
    const result = await httpRequest(
      url,
      { method: "POST" },
      {
        retry: true,
        retryStatus,
        service: "Linear",
        random: () => 0.5,
        sleep: async (ms) => {
          waits.push(ms);
        },
        onRetry: (message) => notices.push(message),
        fetch: async () => {
          const response = new Response("answer", { status: statuses[responses.length] });
          responses.push(response);
          return response;
        },
      },
      async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      },
    ).catch((error: Error) => error.message);
    expect(result).toBe(statuses[2] === 200 ? "answer" : "HTTP 503");
    expect(waits).toEqual([1000, 3000]);
    expect(responses.slice(0, 2).every((response) => response.bodyUsed)).toBe(true);
    expect(notices).toEqual([
      "Linear answered 503; trying again in 1 s (2/3)",
      "Linear answered 503; trying again in 3 s (3/3)",
    ]);
  }
  let calls = 0;
  expect(
    await httpRequest(
      url,
      { method: "POST" },
      {
        retryStatus,
        fetch: async () => {
          calls++;
          return new Response("busy", { status: 503 });
        },
      },
      async (res) => res.status,
    ),
  ).toBe(503);
  expect(calls).toBe(1);
});

test("Retry-After honors seconds and dates, caps waits, refuses long 429s, and cancellation stops retries", async () => {
  for (const [status, after, random, expected] of [
    [503, "2", 0, 2000],
    [503, "30", 1, 10000],
    [429, "Mon, 05 Oct 2026 12:00:04 GMT", 0.5, 4000],
    [503, "invalid", 0, 800],
    [503, "0", 1, 1200],
  ] as const) {
    let calls = 0;
    const waits: number[] = [];
    await httpRequest(
      url,
      {},
      {
        retry: true,
        retryStatus,
        random: () => random,
        now: () => new Date("2026-10-05T12:00:00Z"),
        sleep: async (ms) => {
          waits.push(ms);
        },
        fetch: async () =>
          ++calls === 1 ? new Response("busy", { status, headers: { "Retry-After": after } }) : new Response("ok"),
      },
      (res) => res.text(),
    );
    expect(waits).toEqual([expected]);
  }
  let calls = 0;
  await expect(
    httpRequest(
      url,
      {},
      {
        retry: true,
        retryStatus,
        sleep: async () => {
          throw new Error("must not wait");
        },
        fetch: async () => {
          calls++;
          return new Response("limited", { status: 429, headers: { "Retry-After": "11" } });
        },
      },
      (res) => res.text(),
    ),
  ).rejects.toThrow("HTTP 429; try again after 11");
  expect(calls).toBe(1);

  const controller = new AbortController();
  const cancelled = new DOMException("caller cancelled", "AbortError");
  calls = 0;
  const error = await httpRequest(
    url,
    { signal: controller.signal },
    {
      retry: true,
      retryStatus,
      fetch: async () => {
        calls++;
        return new Response("busy", { status: 502 });
      },
      sleep: async () => {
        controller.abort(cancelled);
      },
    },
    (res) => res.text(),
  ).catch((error) => error);
  expect(error).toBe(cancelled);
  expect(calls).toBe(1);
});

test("repeated Retry-After headers stay within the call's 14 s wait budget", async () => {
  for (const status of [503, 429]) {
    const waits: number[] = [];
    let calls = 0;
    const answer = await httpRequest(
      url,
      {},
      {
        retry: true,
        retryStatus,
        random: () => 0.5,
        sleep: async (ms) => {
          waits.push(ms);
        },
        fetch: async () =>
          ++calls < 3 ? new Response("busy", { status, headers: { "Retry-After": "10" } }) : new Response("ok"),
      },
      (res) => res.text(),
    ).catch((error: Error) => error.message);
    expect(waits).toEqual(status === 503 ? [10000, 4000] : [10000]);
    expect(answer).toBe(status === 503 ? "ok" : "HTTP 429; try again after 10 s");
  }
});
