import { expect, test } from "bun:test";
import { LaunchError, ProviderError, VaultError } from "@armada/core/server";
import { lifecycleStep, modalError } from "../../provider-modal/src/errors.ts";
import { OrchestratorDiagnostics } from "../src/orchestrator-diagnostics.ts";

test("diagnostics project only safe codes/UUIDs and retain failure identity across cleanup/publication", () => {
  const lines: string[] = [];
  let privateReads = 0;
  const sensitive = "synthetic-private-prompt-token-source-detail";
  const error = new ProviderError({ provider: sensitive, code: "unavailable", message: sensitive, retryable: false });
  Object.defineProperties(error, {
    message: {
      get() {
        privateReads++;
        throw Error(sensitive);
      },
    },
    stack: {
      get() {
        privateReads++;
        throw Error(sensitive);
      },
    },
    cause: {
      get() {
        privateReads++;
        return error;
      },
    },
  });
  const diagnostics = new OrchestratorDiagnostics((line) => lines.push(line), "create");
  diagnostics.bind({
    operationId: "11111111-1111-4111-8111-111111111111",
    orchestratorId: sensitive,
    sandboxId: sensitive,
  });
  diagnostics.stage("fork");
  diagnostics.capture(error);
  diagnostics.stage("initialization");
  diagnostics.capture({ code: sensitive, message: sensitive });
  diagnostics.report("uncertain", error);
  diagnostics.stage("failure_publication");
  diagnostics.report("publication_failed", { code: "23514", detail: sensitive });
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    {
      event: "orchestrator_operation_failure",
      component: "owner",
      action: "create",
      outcome: "uncertain",
      stage: "fork",
      reason: "provider_unavailable",
      operationId: "11111111-1111-4111-8111-111111111111",
    },
    {
      event: "orchestrator_operation_failure",
      component: "owner",
      action: "create",
      outcome: "publication_failed",
      stage: "failure_publication",
      reason: "sql_check",
      failureStage: "fork",
      failureReason: "provider_unavailable",
      operationId: "11111111-1111-4111-8111-111111111111",
    },
  ]);
  expect(privateReads).toBe(0);
  expect(lines.join("\n")).not.toContain(sensitive);
});

test("unknown/hostile codes and failed synchronous/asynchronous log sinks cannot escape diagnostics", async () => {
  const lines: string[] = [];
  const diagnostics = new OrchestratorDiagnostics((line) => lines.push(line), "untrusted-prompt-text");
  diagnostics.stage("message");
  diagnostics.report("uncertain", { code: "untrusted-secret-code", message: "untrusted-secret-code" });
  const hostile = new OrchestratorDiagnostics((line) => lines.push(line), "resume");
  hostile.report("error", {
    get code() {
      throw Error("untrusted-secret-code");
    },
  });
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    {
      event: "orchestrator_operation_failure",
      component: "owner",
      action: "unknown",
      outcome: "uncertain",
      stage: "message",
      reason: "unexpected_error",
    },
    {
      event: "orchestrator_operation_failure",
      component: "owner",
      action: "resume",
      outcome: "error",
      stage: "authorization",
      reason: "unexpected_error",
    },
  ]);
  expect(() =>
    new OrchestratorDiagnostics(() => {
      throw Error("untrusted-secret-code");
    }, "stop").report("failed"),
  ).not.toThrow();
  new OrchestratorDiagnostics(async () => {
    throw Error("untrusted-secret-code");
  }, "stop").report("uncertain");
  await Promise.resolve();
});

// These refusals can happen during a real Modal create before a usable parent
// exists; the reason must not collapse to an unexpected-error placeholder.
test("known provider readiness, billing and harness refusals retain their safe reasons", () => {
  const lines: string[] = [];
  for (const code of ["sandbox_not_ready", "payment_required", "provider_not_configured"] as const) {
    const diagnostics = new OrchestratorDiagnostics((line) => lines.push(line), "create");
    diagnostics.stage("fork");
    diagnostics.report(
      "uncertain",
      new ProviderError({ provider: "modal", code, message: "synthetic-private-provider-detail", retryable: false }),
    );
  }
  expect(lines.map((line) => JSON.parse(line).reason)).toEqual([
    "provider_sandbox_not_ready",
    "provider_payment_required",
    "provider_provider_not_configured",
  ]);
  expect(lines.join("\n")).not.toContain("synthetic-private-provider-detail");
});

test("Modal lifecycle labels are allowlisted while opaque provider diagnostics stay private", () => {
  const lines: string[] = [];
  for (const providerCode of [
    "modal_boot_baseline",
    "modal_checkpoint_scrub",
    "modal_recovery_binding",
    "private-provider-detail",
  ]) {
    const diagnostic = new OrchestratorDiagnostics((line) => lines.push(line), "create");
    diagnostic.stage("fork");
    diagnostic.report(
      "uncertain",
      new ProviderError({
        provider: "modal",
        code: "conflict",
        providerCode,
        message: "private-provider-detail",
        retryable: false,
      }),
    );
  }
  expect(lines.map((line) => JSON.parse(line).reason)).toEqual([
    "provider_conflict_modal_boot_baseline_armada_refusal",
    "provider_conflict_modal_checkpoint_scrub_armada_refusal",
    "provider_conflict_modal_recovery_binding_armada_refusal",
    "provider_conflict",
  ]);
  expect(lines.join("\n")).not.toContain("private-provider-detail");
});

test("launcher causes expose only normalized codes and bounded data-property metadata", () => {
  const lines: string[] = [];
  const cause = new VaultError("not_found", "private-registry-output");
  const wrapped = new LaunchError("start_failed", "private-launcher-output", { cause });
  const diagnostics = new OrchestratorDiagnostics((line) => lines.push(line), "create");
  diagnostics.stage("initialization_mcp");
  diagnostics.report("uncertain", wrapped);
  expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
    stage: "initialization_mcp",
    reason: "launcher_start_failed_caused_by_credential_not_found",
  });
  let reads = 0;
  const hostile = new LaunchError("start_failed", "private-launcher-output");
  Object.defineProperty(hostile, "cause", {
    get() {
      reads++;
      throw Error("private-cause");
    },
  });
  const safe = new OrchestratorDiagnostics((line) => lines.push(line), "create");
  safe.report("uncertain", hostile);
  expect(reads).toBe(0);
  expect(lines.join("\n")).not.toContain("private-");
});

// Transport metadata must survive lifecycle wrapping, without copying upstream payloads.
test.each([
  ["AlreadyExistsError", undefined, "provider_conflict_modal_checkpoint_scrub_AlreadyExistsError"],
  ["ClientError", 6, "provider_unknown_modal_checkpoint_scrub_grpc_grpc_6"],
  ["private-upstream-class", 6, "provider_unknown_modal_checkpoint_scrub_unknown"],
] as const)("Modal %s is classified without upstream messages", async (name, code, expected) => {
  const lines: string[] = [];
  const upstream = Object.assign(new Error("synthetic-private-upstream-payload"), { name, code });
  const diagnostics = new OrchestratorDiagnostics((line) => lines.push(line), "stop");
  try {
    await lifecycleStep("modal_checkpoint_scrub", async () => {
      throw upstream;
    });
  } catch (error) {
    diagnostics.report("uncertain", modalError(error));
  }
  expect(JSON.parse(lines[0]!).reason).toBe(expected);
  expect(lines.join("")).not.toContain("synthetic-private-upstream-payload");
  expect(lines.join("")).not.toContain("private-upstream-class");
});
