import { expect, test } from "bun:test";
import type { Provider } from "@armada/core/server";
import { createRuntimeProvider } from "../src/runtime-provider.ts";

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
    () => runtime.prompt({ sandboxId: "physical", harness: "codex", text: "must not send" }),
    () => runtime.exec({ sandboxId: "physical", command: "must not exec" }),
    () => runtime.interrupt({ sandboxId: "physical" }),
    () => runtime.quiesce?.({ sandboxId: "physical" }),
    () => runtime.sshKey({ sandboxId: "physical", key: "must not register" }),
  ])
    await expect(attempt()).rejects.toMatchObject({ code: "invalid_request", retryable: false });
  expect(runtime.configureMcp).toBeUndefined();
  expect(runtime.collectTurnUsage).toBeUndefined();
  expect(calls).toHaveLength(5);
});
