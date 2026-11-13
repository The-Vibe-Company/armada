import type { Harness, ModelConnectionTestResult } from "@armada/core";
import type { ActionResult } from "./action";

/** Only the viewer's recent running Modal sandboxes; no provider ids or secret/configuration values. */
export type ConnectionTestChoices =
  | { state: "unavailable" }
  | {
      state: "ready";
      sandboxes: { id: string; accountId: string; version: number; harness: Harness; createdAt: string }[];
    };

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
  if (result.ok) return { ok: true, message: "Connection accepted. Streaming and tool support have not been checked." };
  let error = "The provider could not complete the check. Try again later.";
  if (result.status === null)
    error = "The connection could not be reached. Check the provider address and your machine's network access.";
  else if (
    ["invalid_api_key", "authentication_error", "permission_error"].includes(result.code ?? "") ||
    [401, 403].includes(result.status)
  )
    error = "The provider did not accept this account. Check its key and access permissions.";
  else if (
    ["model_not_found", "DeploymentNotFound", "not_found_error"].includes(result.code ?? "") ||
    result.status === 404
  )
    error = "The model or deployment was not found. Check its name in your provider account.";
  else if (["rate_limit_error", "insufficient_quota"].includes(result.code ?? "") || result.status === 429)
    error = "The provider's usage limit was reached. Check the account's limits before trying again.";
  else if (result.error === "invalid_response")
    error = "The provider returned an unsupported response. Check that this connection supports the selected agent.";
  return { ok: false, error };
}
