import { expect, test } from "bun:test";
import type { Provider } from "@armada/core/server";
import { createRuntimeProvider } from "../src/runtime-provider.ts";

type RuntimeHost = Parameters<typeof createRuntimeProvider>[0];
type SetRuntimeTtl = NonNullable<RuntimeHost["setRuntimeTtl"]>;

function ttlHost(id: "boat" | "modal", setRuntimeTtl?: SetRuntimeTtl) {
  const host = { id, setRuntimeTtl } as RuntimeHost;
  return createRuntimeProvider(host, "physical", host);
}

test("enrolled Boat forwards TTL and the lifecycle signal for its own physical sandbox", async () => {
  const received: { provider: string; request: Parameters<SetRuntimeTtl>[0] }[] = [];
  const runtime = ttlHost("boat", async function (this: RuntimeHost, request) {
    received.push({ provider: this.id, request });
  });
  const signal = new AbortController().signal;
  await runtime.setRuntimeTtl!({ sandboxId: "physical", ttlSeconds: 600, signal });
  expect(received).toEqual([{ provider: "boat", request: { sandboxId: "physical", ttlSeconds: 600, signal } }]);
  expect(received[0]?.request.signal).toBe(signal);
});

test.each([
  ["wrong physical sandbox", "other", new AbortController().signal, { code: "not_found" }],
  ["lost lifecycle ownership", "physical", AbortSignal.abort(new Error("lease lost")), { message: "lease lost" }],
] as const)("enrolled Boat refuses TTL dispatch for %s", async (_label, sandboxId, signal, failure) => {
  let dispatched = false;
  const runtime = ttlHost("boat", async () => {
    dispatched = true;
  });
  await expect(runtime.setRuntimeTtl!({ sandboxId, ttlSeconds: 600, signal })).rejects.toMatchObject(failure);
  expect(dispatched).toBe(false);
});

test("runtime TTL is unavailable without an explicit Boat host port", () => {
  expect(ttlHost("boat").setRuntimeTtl).toBeUndefined();
  expect(ttlHost("modal", async () => {}).setRuntimeTtl).toBeUndefined();
});

test("runtime sandbox adapter exposes bound reads/compute cleanup, never host agent or optional fallback", async () => {
  const calls: string[] = [];
  const host = new Proxy(
    { id: "boat" },
    {
      get(object, key) {
        if (key === "id") return object.id;
        if (["backendIdentity", "managementIdentity"].includes(String(key))) return undefined;
        return async () => {
          calls.push(String(key));
          if (key === "get") return { id: "physical", state: "ready" };
          return { status: "deleted" };
        };
      },
    },
  ) as unknown as Provider;
  const runtime = createRuntimeProvider(host, "physical", {
    async getPrompt() {
      calls.push("runtime-prompt-read");
      return { promptId: "p", status: "finished", done: true };
    },
    async events() {
      calls.push("runtime-events");
      return { events: [], source: "armada-runtime", hasMore: false };
    },
  });
  await runtime.get("physical");
  expect(await runtime.getPrompt({ sandboxId: "physical", promptId: "p" })).toMatchObject({ done: true });
  expect(await runtime.events({ sandboxId: "physical" })).toMatchObject({ source: "armada-runtime" });
  await runtime.stop({ sandboxId: "physical" });
  await runtime.delete({ sandboxId: "physical" });
  expect(calls).toEqual(["get", "runtime-prompt-read", "runtime-events", "stop", "delete"]);
  await expect(runtime.get("other")).rejects.toMatchObject({ code: "not_found" });
  await expect(runtime.events({ sandboxId: "other" })).rejects.toMatchObject({ code: "not_found" });
  for (const attempt of [
    () => runtime.exec({ sandboxId: "physical", command: "must not exec" }),
    () => runtime.interrupt({ sandboxId: "physical" }),
    () => runtime.sshKey({ sandboxId: "physical", key: "must not register" }),
  ])
    await expect(attempt()).rejects.toMatchObject({ code: "invalid_request", retryable: false });
  expect(calls).toHaveLength(5);
  // Declared outputs are a fixed host read, bound to this sandbox, so enrolled runtimes publish them.
  await runtime.readOutputs?.({ sandboxId: "physical" });
  expect(calls.at(-1)).toBe("readOutputs");
  await expect(runtime.readOutputs?.({ sandboxId: "other" })).rejects.toMatchObject({ code: "not_found" });
});
