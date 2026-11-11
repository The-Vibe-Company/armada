import { expect, spyOn, test } from "bun:test";
import { CREDENTIAL_BUSY_MESSAGE, MODEL_CATALOG, ProviderError, VaultError } from "@armada/core";
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
  expect(await create.json()).toEqual({ error: { code: "dependency_unavailable", message: "dependency_unavailable" } });
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
  const create = spyOn(service, "create");
  for (const changed of [
    { skill: "--evil" },
    { skill: "example/armada-tools@1.0.0" },
    { skill: "example/notes" },
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
  expect(create).not.toHaveBeenCalled(); // No reservation or launch before synchronous validation.
  create.mockRestore();
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

test("requested production pairs stay unavailable and explain their independent native blockers", async () => {
  const { orchestratorPairsFromEnv } = await import("../src/orchestrator-activation.ts");
  const { callOrchestrator } = await import("../src/orchestrator-api.ts");
  const pairs = orchestratorPairsFromEnv(" boat:claude,boat:codex,modal:codex,boat:codex ");
  const caller: Caller = { userId: "owner", orgs: [], via: "supabase" };
  const response = await orchestratorHttp(
    new Request("https://armada.invalid/api/v1/orchestrators/capabilities"),
    caller,
    undefined,
    pairs,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const expected = {
    version: 1,
    enabled: false,
    reason: "native_conformance_required",
    delegatedWaits: { enabled: false, reason: "admit_wait_not_supported" },
    pairs: [
      {
        provider: "boat",
        harness: "claude",
        requested: true,
        enabled: false,
        reason: "production_runtime_unavailable",
        continuity: "best_effort",
      },
      {
        provider: "boat",
        harness: "codex",
        requested: true,
        enabled: false,
        reason: "production_runtime_unavailable",
        continuity: "best_effort",
      },
      {
        provider: "modal",
        harness: "claude",
        requested: false,
        enabled: false,
        reason: "native_resume_driver_unavailable",
        continuity: "native",
      },
      {
        provider: "modal",
        harness: "codex",
        requested: true,
        enabled: false,
        reason: "production_runtime_unavailable",
        continuity: "native",
      },
    ],
    harnesses: [
      {
        harness: "claude",
        defaultModel: MODEL_CATALOG.claude.defaultModel,
        defaultReasoningEffort: MODEL_CATALOG.claude.defaultReasoningEffort,
        reasoningEfforts: [...MODEL_CATALOG.claude.reasoningEfforts],
        models: MODEL_CATALOG.claude.models.map(({ id, label, reasoningEfforts }) => ({
          id,
          label,
          reasoningEfforts: [...reasoningEfforts],
        })),
        accountKinds: ["claude_oauth", "anthropic"],
      },
      {
        harness: "codex",
        defaultModel: MODEL_CATALOG.codex.defaultModel,
        defaultReasoningEffort: MODEL_CATALOG.codex.defaultReasoningEffort,
        reasoningEfforts: [...MODEL_CATALOG.codex.reasoningEfforts],
        models: MODEL_CATALOG.codex.models.map(({ id, label, reasoningEfforts }) => ({
          id,
          label,
          reasoningEfforts: [...reasoningEfforts],
        })),
        accountKinds: ["openai", "codex_auth"],
      },
    ],
  };
  expect(await response.json()).toEqual(expected);
  // MCP consumes this same dispatcher; no provider or owner identity is needed for diagnostics.
  expect(await callOrchestrator(undefined, caller, "capabilities", {}, undefined, pairs)).toEqual(expected);
  const mutation = await orchestratorHttp(
    new Request("https://armada.invalid/api/v1/orchestrators", {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    }),
    caller,
    undefined,
    pairs,
  );
  expect(mutation.status).toBe(503);
});

test("HTTP history options reach the shared dispatcher as typed values", async () => {
  const { OrchestratorRuntime } = await import("../src/orchestrator-runtime.ts");
  const calls: unknown[][] = [];
  const service = new OrchestratorRuntime({} as ConstructorParameters<typeof OrchestratorRuntime>[0]);
  service.events = async (...args) => {
    calls.push(args);
    return { version: 1, events: [], cursor: "live", olderCursor: "older", hasMore: true };
  };
  const caller: Caller = { userId: "owner", orgs: [], via: "supabase" };
  const response = await orchestratorHttp(
    new Request(
      "https://armada.invalid/api/v1/orchestrators/parent/events?orgId=org&direction=backward&limit=10&maxBytes=2048&coalesce=false",
    ),
    caller,
    service,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ olderCursor: "older", cursor: "live" });
  expect(calls).toEqual([
    [caller, "org", "parent", undefined, 10, { direction: "backward", maxBytes: 2048, coalesce: false }],
  ]);
  const malformed = await orchestratorHttp(
    new Request("https://armada.invalid/api/v1/orchestrators/parent/events?orgId=org&coalesce=yes"),
    caller,
    service,
  );
  expect(malformed.status).toBe(400);
  expect(calls).toHaveLength(1);
  service.events = async () => {
    throw new ProviderError({
      provider: "orchestrator",
      code: "invalid_request",
      message: "Invalid event pagination.",
      retryable: false,
    });
  };
  const invalidBudget = await orchestratorHttp(
    new Request("https://armada.invalid/api/v1/orchestrators/parent/events?orgId=org&maxBytes=0"),
    caller,
    service,
  );
  expect(invalidBudget.status).toBe(400);
});

test("synchronous orchestrator credential refusal remains a compatible 409 with a closed reason", async () => {
  const { OrchestratorRuntime } = await import("../src/orchestrator-runtime.ts");
  const service = new OrchestratorRuntime({} as ConstructorParameters<typeof OrchestratorRuntime>[0]);
  service.detail = async () => {
    throw new VaultError("credential_busy", CREDENTIAL_BUSY_MESSAGE);
  };
  const response = await orchestratorHttp(
    new Request("https://armada.invalid/api/v1/orchestrators/parent?orgId=org"),
    { userId: "owner", orgs: [], via: "supabase" },
    service,
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: { code: "conflict", reason: "credential_busy", message: CREDENTIAL_BUSY_MESSAGE },
  });
});
