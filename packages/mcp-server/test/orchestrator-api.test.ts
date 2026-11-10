import { expect, test } from "bun:test";
import { MODEL_CATALOG } from "@armada/core";
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

test("requested production pairs stay unavailable and explain their independent native blockers", async () => {
  const { configFromEnv } = await import("../src/config.ts");
  const { callOrchestrator } = await import("../src/orchestrator-api.ts");
  const { ENCRYPTION_KEY } = await import("./support.ts");
  const config = configFromEnv({
    ARMADA_DATABASE_URL: "postgres://test.invalid/db",
    SUPABASE_URL: "https://supabase.invalid",
    SUPABASE_ANON_KEY: "anon",
    ARMADA_AUTH_SECRET: "a-test-auth-secret-of-enough-length",
    ARMADA_PUBLIC_URL: "https://armada.invalid",
    ARMADA_ENCRYPTION_KEY: ENCRYPTION_KEY,
    ARMADA_ORCHESTRATOR_PAIRS: " boat:claude,boat:codex,modal:codex,boat:codex ",
    ARMADA_ORCHESTRATOR_SKILL_REVISION: "a".repeat(40),
  });
  const caller: Caller = { userId: "owner", orgs: [], via: "supabase" };
  const response = await orchestratorHttp(
    new Request("https://armada.invalid/api/v1/orchestrators/capabilities"),
    caller,
    undefined,
    config.orchestratorPairs,
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
        reason: "boat_native_checkpoint_restore_unavailable",
      },
      {
        provider: "boat",
        harness: "codex",
        requested: true,
        enabled: false,
        reason: "boat_native_checkpoint_restore_unavailable",
      },
      {
        provider: "modal",
        harness: "claude",
        requested: false,
        enabled: false,
        reason: "native_resume_driver_unavailable",
      },
      {
        provider: "modal",
        harness: "codex",
        requested: true,
        enabled: false,
        reason: "production_runtime_unavailable",
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
  expect(await callOrchestrator(undefined, caller, "capabilities", {}, undefined, config.orchestratorPairs)).toEqual(
    expected,
  );
  const mutation = await orchestratorHttp(
    new Request("https://armada.invalid/api/v1/orchestrators", {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    }),
    caller,
    undefined,
    config.orchestratorPairs,
  );
  expect(mutation.status).toBe(503);
});
