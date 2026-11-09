import { expect, test } from "bun:test";
import type { Caller } from "../src/caller.ts";
import { orchestratorHttp } from "../src/orchestrator-api.ts";

test("unconfigured orchestrators report off and refuse mutations without touching provider resources", async () => {
  const caller: Caller = { userId: "owner", orgs: [], via: "supabase" };
  const capability = await orchestratorHttp(
    new Request("https://armada.invalid/api/v1/orchestrators/capabilities"),
    caller,
  );
  expect(await capability.json()).toEqual({ version: 1, enabled: false, reason: "native_conformance_required" });
  const create = await orchestratorHttp(
    new Request("https://armada.invalid/api/v1/orchestrators", {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    }),
    caller,
  );
  expect(create.status).toBe(503);
  expect(create.headers.get("cache-control")).toBe("no-store");
  expect(await create.json()).toEqual({ error: { code: "unavailable", message: "unavailable" } });
});

test("shared boundary rejects malformed optional configuration and unknown mutation fields before backend admission", async () => {
  const { callOrchestrator } = await import("../src/orchestrator-api.ts");
  const { OrchestratorRuntime } = await import("../src/orchestrator-runtime.ts");
  const service = new OrchestratorRuntime({} as ConstructorParameters<typeof OrchestratorRuntime>[0]);
  const caller: Caller = { userId: "owner", orgs: [{ orgId: "org", role: "member" }], via: "supabase" };
  const valid = {
    version: 1,
    orgId: "org",
    name: "coordinator",
    goldenId: "golden",
    provider: "boat",
    harness: "claude",
    model: "model",
    modelAccountId: "account",
  };
  for (const changed of [
    { repo: {} },
    { reasoningEffort: 42 },
    { idleSeconds: -1 },
    { idleSeconds: 86401 },
    { maxActiveChildren: 0 },
    { maxActiveChildren: 1.5 },
    { unknown: true },
  ]) {
    await expect(callOrchestrator(service, caller, "create", { ...valid, ...changed }, "key")).rejects.toThrow(
      "invalid_request",
    );
  }
  await expect(
    callOrchestrator(
      service,
      caller,
      "message",
      { orgId: "org", id: "parent", expectedRevision: 1, text: "hello", unknown: true },
      "key",
    ),
  ).rejects.toThrow("invalid_request");
});
