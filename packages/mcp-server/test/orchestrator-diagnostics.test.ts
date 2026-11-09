import { expect, test } from "bun:test";
import { ProviderError } from "@armada/core/server";
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
