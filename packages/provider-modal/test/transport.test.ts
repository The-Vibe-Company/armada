import { expect, test } from "bun:test";
import type { Machine } from "../src/ports.ts";
import { createRunnerTransport } from "../src/transport.ts";

const machine: Machine = {
  info: { id: "workspace", name: "workspace", state: "ready", providerState: "active", labels: {} },
  phase: "active",
  generation: 1,
  golden: false,
  ttlSeconds: 60,
  physicalName: "workspace",
};

const runnerAccess = () => ({
  url: "https://runner.example",
  connectToken: "connect",
  grant: "grant",
  expiresAt: Date.now() + 60_000,
});

function success(init?: RequestInit) {
  const { requestId } = JSON.parse(String(init?.body));
  return Response.json({ version: 1, requestId, result: { exitCode: 0 } });
}

test.each(["before access", "during access"])("exec abort %s prevents runner dispatch", async (phase) => {
  const controller = new AbortController();
  const cancellation = new Error("activity ended");
  let lookups = 0;
  let dispatches = 0;
  const transport = createRunnerTransport(
    async () => {
      lookups++;
      controller.abort(cancellation);
      return runnerAccess();
    },
    (async (_url, init) => {
      dispatches++;
      return success(init);
    }) as typeof fetch,
  );
  if (phase === "before access") controller.abort(cancellation);
  await expect(transport.call(machine, "exec", { input: { command: "pwd", signal: controller.signal } })).rejects.toBe(
    cancellation,
  );
  expect(lookups).toBe(phase === "before access" ? 0 : 1);
  expect(dispatches).toBe(0);
});

test("exec cancellation reaches the in-flight HTTP request and stays out of its body", async () => {
  const controller = new AbortController();
  const cancellation = new Error("activity ended");
  let wireInput: unknown;
  const transport = createRunnerTransport(async () => runnerAccess(), (async (_url, init) => {
    wireInput = JSON.parse(String(init?.body)).input;
    controller.abort(cancellation);
    init?.signal?.throwIfAborted();
    return success(init);
  }) as typeof fetch);
  const request = transport.call(machine, "exec", { input: { command: "pwd", signal: controller.signal } });
  await expect(request).rejects.toBe(cancellation);
  expect(wireInput).toEqual({ command: "pwd" });
});
