import { expect, spyOn, test } from "bun:test";

import { continueRequest, observeProviderCall, observeRequest } from "../src/request-observability.ts";

test.each([
  ["HTTP request", (work: () => Promise<Response>) => observeRequest(work)],
  ["resumed request", (work: () => Promise<Response>) => continueRequest(crypto.randomUUID(), work)],
] as const)("%s logs provider success at info and refusal at warn", async (_context, run) => {
  const sinks = {
    info: spyOn(console, "info"),
    warn: spyOn(console, "warn"),
    error: spyOn(console, "error"),
  };
  try {
    await run(async () => {
      await observeProviderCall("modal", "get", async () => true);
      await observeProviderCall(
        "docker",
        "stop",
        async () => false,
        (accepted) => accepted,
      );
      return new Response();
    });
    const expected = { info: ["ok"], warn: ["error"], error: [] };
    for (const level of ["info", "warn", "error"] as const) {
      const outcomes = sinks[level].mock.calls
        .map(([line]) => JSON.parse(line))
        .filter((record) => record.event === "provider_call")
        .map((record) => record.outcome);
      expect(outcomes).toEqual(expected[level]);
    }
  } finally {
    for (const sink of Object.values(sinks)) sink.mockRestore();
  }
});
