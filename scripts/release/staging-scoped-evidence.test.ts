import { expect, test } from "bun:test";
import { scopedEvidence, scopedEvidenceFilter } from "./staging-scoped-evidence.ts";

test("joins scoped smoke failures to candidate operator diagnostics without copying raw log fields", () => {
  const operationId = "00000000-0000-4000-8000-000000000001";
  const requestId = "00000000-0000-4000-8000-000000000002";
  const missingId = "00000000-0000-4000-8000-000000000003";
  const smoke = [
    { step: "scoped_launch_diagnostic", operationId },
    { step: "scoped_message_diagnostic", toolRequestId: requestId },
    { step: "scoped_stop_diagnostic", operationId: missingId, toolRequestId: "invalid filter" },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
  const logs = [
    {
      event: "operator_failure",
      phase: "scoped.child_launch.dispatch_admission",
      operationId,
      code: "child_dispatch_not_admitted",
      errorClass: "PostgresError",
      message: "SQLSTATE 42P01",
      extra: "private",
    },
    { event: "operator_failure", phase: "scoped.mcp.message", requestId, message: "private" },
    { event: "http_request", requestId },
    { event: "operator_failure", phase: "scoped.mcp.message" },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
  expect(scopedEvidenceFilter(smoke)).toBe(
    `@event:operator_failure AND (@operationId:${operationId} OR @requestId:${requestId} OR @operationId:${missingId})`,
  );
  expect(scopedEvidence(smoke, logs)).toEqual({
    step: "scoped_server_evidence",
    diagnostics: [
      {
        operationId,
        phase: "scoped.child_launch.dispatch_admission",
        code: "child_dispatch_not_admitted",
        errorClass: "PostgresError",
        sqlState: "42P01",
      },
      { requestId, phase: "scoped.mcp.message" },
    ],
    unmatchedOperationIds: [missingId],
    unmatchedRequestIds: [],
  });
});
