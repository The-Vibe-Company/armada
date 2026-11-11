import { expect, test } from "bun:test";
import { orchestratorSummary, parseOrchestratorCommand } from "../src/orchestrator-commands.ts";

test("create selection distinguishes defaults, explicit none and exclusive connections", () => {
  const args = [
    "create",
    "coordinator",
    "--org",
    "org",
    "--golden",
    "golden",
    "--provider",
    "boat",
    "--agent",
    "claude",
    "--model",
    "model",
    "--model-account",
    "account",
    "--idempotency-key",
    "create",
  ];
  for (const [options, selection] of [
    [[], undefined],
    [["--no-connections"], []],
    [
      ["--connections", "first,second"],
      ["first", "second"],
    ],
  ] as const) {
    const command = parseOrchestratorCommand([...args, ...options]);
    expect("body" in command && "connections" in command.body ? command.body.connections : undefined).toEqual(
      selection === undefined ? undefined : [...selection],
    );
  }
  for (const options of [
    ["--connections", "first", "--no-connections"],
    ["--connections", "first,"],
  ])
    expect(() => parseOrchestratorCommand([...args, ...options])).toThrow();
});

// Parser owns CLI-to-contract translation; these are not server/runtime integration tests.
test("create preserves explicit account/repository/model choices and leaves defaults to the server", () => {
  const command = parseOrchestratorCommand([
    "create",
    "Review coordinator",
    "--org",
    "org-1",
    "--golden",
    "golden-1",
    "--provider",
    "modal",
    "--agent",
    "codex",
    "--model",
    "chosen-model",
    "--model-account",
    "account-1",
    "--repo",
    "owner/repo",
    "--reasoning-effort",
    "high",
    "--idempotency-key",
    "create-1",
    "--json",
  ]);
  expect(command).toEqual({
    action: "create",
    key: "create-1",
    orgId: "org-1",
    json: true,
    all: false,
    follow: false,
    body: {
      version: 1,
      orgId: "org-1",
      name: "Review coordinator",
      goldenId: "golden-1",
      provider: "modal",
      harness: "codex",
      model: "chosen-model",
      modelAccountId: "account-1",
      repo: "owner/repo",
      reasoningEffort: "high",
    },
  });
});

test("mutations preserve the caller key/revision and resume never manufactures a message", () => {
  for (const action of ["send", "steer", "stop", "resume"] as const) {
    const message = action === "send" || action === "steer";
    const command = parseOrchestratorCommand([
      action,
      "orchestrator-1",
      "--org",
      "org-1",
      ...(message ? ["continue the review"] : []),
      "--idempotency-key",
      "original-key",
      "--expected-revision",
      "7",
    ]);
    expect(command).toEqual({
      action: action === "send" ? "message" : action,
      id: "orchestrator-1",
      key: "original-key",
      orgId: "org-1",
      body: { expectedRevision: 7, ...(message ? { text: "continue the review" } : {}) },
      json: false,
      all: false,
      follow: false,
    });
  }
});

test("rejects ambiguous or unfenced mutations before transport", () => {
  for (const argv of [
    ["resume", "id", "--idempotency-key", "key"],
    ["resume", "id", "--expected-revision", "2"],
    ["resume", "id", "fake resume prompt", "--expected-revision", "2", "--idempotency-key", "key"],
    ["stop", "id", "--expected-revision", "1.5", "--idempotency-key", "key"],
    ["stop", "id", "--expected-revision", "9007199254740992", "--idempotency-key", "key"],
    ["stop", "id", "--expected-revision", "2", "--idempotency-key", "key\nvalue"],
    ["stop", "id", "--expected-revision", "2", "--idempotency-key", " key "],
    ["stop", "id", "--expected-revision", "2", "--idempotency-key", "key", "--idempotency-key", "other"],
    ["send", "id", " ", "--expected-revision", "2", "--idempotency-key", "key"],
    ["list", "--org", "org", "--follow"],
  ])
    expect(() => parseOrchestratorCommand(argv.includes("--org") ? argv : [...argv, "--org", "org-1"])).toThrow();
});

test("cursor remains opaque and query encoding is safe for reconnect", () => {
  const command = parseOrchestratorCommand([
    "events",
    "id",
    "--org",
    "org-1",
    "--cursor",
    "a+/=&?",
    "--limit",
    "500",
    "--follow",
    "--json",
  ]);
  expect(command.action).toBe("events");
  if (!("query" in command)) throw new Error("Expected read command");
  expect(command.query.toString()).toBe("orgId=org-1&cursor=a%2B%2F%3D%26%3F&limit=500");
  expect(command.follow).toBe(true);
  for (const limit of ["0", "501", "1e2"])
    expect(() => parseOrchestratorCommand(["events", "id", "--org", "org-1", "--limit", limit])).toThrow();
});

test("operation summary does not claim an admitted resume completed", () => {
  expect(
    orchestratorSummary({
      version: 1,
      id: "op-1",
      orchestratorId: "id-1",
      kind: "resume",
      state: "uncertain",
      revision: 8,
      errorCode: "continuity_unverified",
    }),
  ).toBe("resume uncertain: operation op-1; orchestrator id-1; revision 8; continuity_unverified");
});
