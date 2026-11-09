import { expect, test } from "bun:test";
import type { OrchestratorCreate } from "@armada/core";
import { resolveMachineSize } from "@armada/core/server";
import { callOrchestrator } from "../src/orchestrator-api.ts";
import { orchestratorParentLaunchRequest } from "../src/orchestrator-launch-request.ts";
import type { OrchestratorRuntime } from "../src/orchestrator-runtime.ts";

const configuration: OrchestratorCreate = {
  version: 1,
  orgId: "org",
  name: "coordinator",
  goldenId: "golden",
  provider: "boat",
  harness: "claude",
  model: "model",
  modelAccountId: "account",
};
const caller = { userId: "owner", orgs: [{ orgId: "org", role: "member" as const }], via: "supabase" as const };

test("orchestrator override and explicit repo map to merged sizing policy, never backend defaults", () => {
  const backend = {
    golden: "golden",
    provider: "boat" as const,
    harness: "claude" as const,
    size: "xlarge" as const,
    repo: "backend-default",
  };
  const policy = { version: 1 as const, golden: "large" as const, repositories: { web: "medium" as const } };
  for (const [selectors, expected, source] of [
    [{ size: "small", repo: "web" }, "small", "override"],
    [{ repo: "web" }, "medium", "repository"],
    [{}, "large", "golden"],
  ] as const) {
    const mapped = orchestratorParentLaunchRequest({ ...configuration, ...selectors }, backend);
    const resolved = resolveMachineSize("boat", mapped.size, mapped.repo ?? null, policy);
    expect(resolved.effective).toBe(expected);
    expect(resolved.source).toBe(source);
  }
  const legacy = orchestratorParentLaunchRequest(configuration, backend);
  expect(resolveMachineSize("boat", legacy.size, legacy.repo ?? null, null).source).toBe("legacy");
});

test("shared create boundary accepts canonical size and rejects native/unknown values before admission", async () => {
  let admitted = 0;
  const service = {
    create: async (_caller: unknown, input: OrchestratorCreate) => {
      admitted++;
      return { size: input.size };
    },
  } as unknown as OrchestratorRuntime;
  expect(await callOrchestrator(service, caller, "create", { ...configuration, size: "large" }, "key")).toEqual({
    size: "large",
  });
  for (const size of ["default", "huge", null, 3, {}])
    await expect(callOrchestrator(service, caller, "create", { ...configuration, size }, "key")).rejects.toThrow(
      "invalid_request",
    );
  expect(admitted).toBe(1);
});

test("create size is durable intent and changed override conflicts on the same scoped key", async () => {
  const { database } = await import("./support.ts");
  const { OrchestratorRuntimeStore } = await import("../src/orchestrator-runtime-store.ts");
  const { reserveOrchestratorOperation } = await import("@armada/core/server");
  const { db, people: p } = await database();
  const store = new OrchestratorRuntimeStore(
    {
      query: (q, v) => db.query(q, v),
      transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
    },
    reserveOrchestratorOperation,
  );
  try {
    const input = { ...configuration, orgId: p.org, size: "small" as const };
    const first = await store.create({
      ownerId: p.owner,
      configuration: input,
      key: "sized",
      skillRevision: "a".repeat(40),
    });
    expect((await store.read(p.owner, p.org, first.identity.id)).configuration.size).toBe("small");
    const repeat = await store.create({
      ownerId: p.owner,
      configuration: input,
      key: "sized",
      skillRevision: "a".repeat(40),
    });
    expect(repeat.operation.id).toBe(first.operation.id);
    await expect(
      store.create({
        ownerId: p.owner,
        configuration: { ...input, size: "large" },
        key: "sized",
        skillRevision: "a".repeat(40),
      }),
    ).rejects.toThrow("conflict");
    expect((await db.query("select id from orchestrators")).rows).toHaveLength(1);
  } finally {
    await db.close();
  }
});
