import type { ModelConnectionTestResult } from "@armada/core";
import type { ActionResult } from "./action";

/** User-JWT metadata must name this exact owner/account/version before probing. */
export function matchesConnectionTestSandbox(
  value: unknown,
  expected: {
    id: string;
    ownerId: string;
    orgId: string;
    accountId: string;
    version: number;
  },
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.id === expected.id &&
    row.owner_id === expected.ownerId &&
    row.org_id === expected.orgId &&
    row.credential_id === expected.accountId &&
    row.credential_version === expected.version &&
    row.provider === "modal" &&
    typeof row.status === "string" &&
    ["ready", "running"].includes(row.status)
  );
}

/** Only closed runtime diagnostics reach UI copy, never endpoint messages or credentials. */
export function connectionTestOutcome(result: ModelConnectionTestResult): ActionResult {
  if (result.ok)
    return {
      ok: true,
      message: `Connection accepted (HTTP ${result.status}). This is not a full harness compatibility test.`,
    };
  return {
    ok: false,
    error:
      result.status === null
        ? "Connection failed or timed out."
        : `Connection rejected: HTTP ${result.status} ${result.code ?? result.error}.`,
  };
}
