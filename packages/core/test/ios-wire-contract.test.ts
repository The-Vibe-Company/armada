import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type AgentEvent,
  HARNESSES,
  MACHINE_SIZES,
  type Orchestrator,
  type OrchestratorContinuity,
  type OrchestratorDetail,
  type OrchestratorEvent,
  type OrchestratorEventPage,
  type OrchestratorList,
  type OrchestratorOperation,
  type OrchestratorScope,
  type OrchestratorState,
  type OrchestratorWaitLease,
  PROMPT_STATUSES,
  SANDBOX_PROVIDERS,
  type SandboxListMetadata,
  type SandboxStatus,
} from "../src/index.ts";

/**
 * The iPhone app's server contract (#962). `apps/ios/.../Fixtures/server-wire-contract.json` holds
 * every value the server sends for each enum-like field and responses built from them with the
 * server's own types; `ServerWireContractTests.swift` decodes it, plus a value the server does not
 * send yet in each field. It stays in sync two ways: `every` fails typecheck when a server union
 * gains a value not listed here, and this test fails when the committed fixture differs from what
 * these types build. Regenerate with `UPDATE_IOS_WIRE_FIXTURE=1 bun test packages/core/test/ios-wire-contract.test.ts`,
 * then `bun run format`.
 */
const fixturePath = fileURLToPath(
  new URL("../../../apps/ios/ArmadaKit/Tests/ArmadaKitTests/Fixtures/server-wire-contract.json", import.meta.url),
);

/** Every member of `T`, checked at compile time: a missing one makes the argument `never`. */
function every<T extends string>() {
  return <const L extends readonly T[]>(list: L & ([Exclude<T, L[number]>] extends [never] ? unknown : never)) => list;
}

type WaitEvent = Extract<OrchestratorEvent, { kind: "wait" }>;
type MessageEvent = Extract<AgentEvent, { kind: "message" }>;

const values = {
  orchestratorState: every<OrchestratorState>()(["creating", "ready", "stopping", "stopped", "resuming", "blocked"]),
  orchestratorContinuity: every<OrchestratorContinuity>()(["not_started", "native", "unverified", "lost"]),
  operationKind: every<OrchestratorOperation["kind"]>()([
    "create",
    "message",
    "steer",
    "stop",
    "resume",
    "connections_add",
    "connections_remove",
  ]),
  operationState: every<OrchestratorOperation["state"]>()(["pending", "succeeded", "failed", "uncertain"]),
  orchestratorEventKind: every<OrchestratorEvent["kind"]>()([
    "agent",
    "state",
    "operation",
    "wait",
    "connections",
    "child",
  ]),
  waitKind: every<OrchestratorWaitLease["kind"]>()(["ci", "child", "external", "task"]),
  waitStatus: every<WaitEvent["status"]>()(["active", "released", "expired"]),
  delegationScope: every<OrchestratorScope>()([
    "worker:launch",
    "worker:read",
    "worker:message",
    "worker:stop",
    "worker:extend",
  ]),
  agentEventKind: every<AgentEvent["kind"]>()(["prompt", "message", "steer", "other"]),
  textMode: every<NonNullable<MessageEvent["textMode"]>>()(["delta", "snapshot"]),
  promptStatus: PROMPT_STATUSES,
  provider: SANDBOX_PROVIDERS,
  harness: HARNESSES,
  machineSize: MACHINE_SIZES,
  sandboxStatus: every<SandboxStatus>()(["starting", "ready", "running", "stopping", "stopped", "failed", "deleted"]),
};

const at = "2026-11-11T00:00:00.000Z";
const id = (prefix: string, index: number) => `${prefix}-${String(index).padStart(4, "0")}`;
const pick = <T>(list: readonly T[], index: number): T => list[index % list.length] as T;

function orchestrator(index: number): Orchestrator {
  return {
    version: 1,
    id: id("orc", index),
    ownerId: "user-0001",
    configuration: {
      version: 1,
      orgId: "org-0001",
      name: `Orchestrator ${index}`,
      goldenId: "golden-0001",
      provider: pick(values.provider, index),
      harness: pick(values.harness, index),
      size: pick(values.machineSize, index),
      model: "model-a",
      reasoningEffort: "medium",
      modelAccountId: "account-0001",
    },
    state: pick(values.orchestratorState, index),
    revision: index + 1,
    sandboxId: id("sbx", index),
    conversationId: id("conv", index),
    continuity: pick(values.orchestratorContinuity, index),
    createdAt: at,
    updatedAt: at,
    lastActivityAt: at,
    idleDeadline: null,
    skillRevision: "0".repeat(40),
    blockedReason: pick(values.orchestratorState, index) === "blocked" ? "runtime_uncertain" : null,
  };
}

const operations: OrchestratorOperation[] = values.operationKind.flatMap((kind, k) =>
  values.operationState.map((state, s) => ({
    version: 1 as const,
    id: id("op", k * 10 + s),
    orchestratorId: "orc-0000",
    kind,
    state,
    revision: 1,
    errorCode: state === "failed" ? "create_failed" : null,
  })),
);

const waits: OrchestratorWaitLease[] = values.waitKind.map((kind, index) => ({
  id: id("wait", index),
  orchestratorId: "orc-0000",
  kind,
  reference: id("ref", index),
  reason: "Waiting.",
  expiresAt: at,
  deadline: at,
}));

const agentEvents: AgentEvent[] = [
  ...values.promptStatus.map((status, index) => ({
    id: id("evt-prompt", index),
    at: 1_700_000_000_000 + index,
    conversationId: "conv-0000",
    promptId: "prompt-0000",
    kind: "prompt" as const,
    text: "Hello",
    status,
    reason: "runtime_uncertain",
  })),
  ...values.textMode.map((textMode, index) => ({
    id: id("evt-message", index),
    at: 1_700_000_001_000 + index,
    promptId: "prompt-0000",
    kind: "message" as const,
    text: "Hi",
    partial: false,
    messageId: "msg-0000",
    textMode,
    model: "model-a",
    tools: [{ id: "tool-0000", name: "bash", input: { command: "ls" }, result: { output: "ok", isError: false } }],
  })),
  { id: "evt-steer-0000", at: 1_700_000_002_000, kind: "steer", text: "Also this", mode: "queue" },
  { id: "evt-other-0000", at: 1_700_000_003_000, kind: "other", type: "provider_note", data: { note: "x" } },
];

const base = (index: number) => ({ id: id("oev", index), orchestratorId: "orc-0000", at, revision: 1 });
const orchestratorEvents: OrchestratorEvent[] = [
  ...agentEvents.map((event, index) => ({ ...base(index), kind: "agent" as const, event })),
  ...values.orchestratorState.map((state, index) => ({
    ...base(100 + index),
    kind: "state" as const,
    state,
    continuity: pick(values.orchestratorContinuity, index),
  })),
  ...operations.map((operation, index) => ({ ...base(200 + index), kind: "operation" as const, operation })),
  ...values.waitStatus.map((status, index) => ({
    ...base(300 + index),
    kind: "wait" as const,
    lease: pick(waits, index),
    status,
  })),
  { ...base(400), kind: "connections", connections: [{ id: "conn-0000", name: "GitHub" }] },
  { ...base(500), kind: "child", sandboxId: "sbx-0000", operationId: "op-0000" },
];

function sandbox(index: number): SandboxListMetadata {
  const provider = pick(values.provider, index);
  return {
    id: id("sbx", index),
    orgId: "org-0001",
    ownerId: "user-0001",
    provider,
    providerSandboxId: provider === "boat" ? id("bx", index) : null,
    boatId: provider === "boat" ? id("bx", index) : null,
    harness: pick(values.harness, index),
    model: "model-a",
    reasoningEffort: "medium",
    status: pick(values.sandboxStatus, index),
    createdAt: at,
    stoppedAt: null,
    expiresAt: at,
    effectiveTtlSeconds: 14400,
    machineSize: pick(values.machineSize, index),
    displayLabel: `sandbox ${index}`,
    canOpen: true,
    canManage: index % 2 === 0,
  };
}

const orchestratorCount = Math.max(values.orchestratorState.length, values.orchestratorContinuity.length);
const sandboxCount = Math.max(values.sandboxStatus.length, values.provider.length, values.machineSize.length);

const responses = {
  orchestratorList: {
    version: 1,
    items: Array.from({ length: orchestratorCount }, (_, index) => orchestrator(index)),
    cursor: null,
  } satisfies OrchestratorList,
  orchestratorDetail: {
    version: 1,
    orchestrator: { ...orchestrator(0), blockedReason: "runtime_uncertain" },
    operations,
    waits,
    delegation: {
      id: "dlg-0000",
      orchestratorId: "orc-0000",
      ownerId: "user-0001",
      orgId: "org-0001",
      scopes: [...values.delegationScope],
      expiresAt: at,
      revokedAt: null,
      childPolicy: "owned_children",
    },
    childSandboxIds: ["sbx-0000"],
    connections: [{ id: "conn-0000", name: "GitHub" }],
  } satisfies OrchestratorDetail,
  orchestratorEvents: {
    version: 1,
    events: orchestratorEvents,
    cursor: "cursor-0001",
    olderCursor: "cursor-0000",
    hasMore: false,
  } satisfies OrchestratorEventPage,
  sandboxList: {
    sandboxes: Array.from({ length: sandboxCount }, (_, index) => sandbox(index)),
    total: sandboxCount,
    page: 1,
    limit: 25,
    hasMore: false,
    nextPage: null,
  } satisfies {
    sandboxes: SandboxListMetadata[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
    nextPage: number | null;
  },
  sandboxEvents: { events: agentEvents, cursor: "cursor-0001", olderCursor: "cursor-0000", hasMore: false } satisfies {
    events: AgentEvent[];
    cursor: string | null;
    olderCursor?: string;
    hasMore: boolean;
  },
};

test("the iPhone app's wire contract fixture matches the server's types and values", () => {
  const expected = { values, responses };
  if (process.env.UPDATE_IOS_WIRE_FIXTURE === "1") writeFileSync(fixturePath, `${JSON.stringify(expected, null, 2)}\n`);
  expect(JSON.parse(readFileSync(fixturePath, "utf8"))).toEqual(JSON.parse(JSON.stringify(expected)));
});
