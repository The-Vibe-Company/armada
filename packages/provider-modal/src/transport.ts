import { randomUUID } from "node:crypto";
import { ProviderError, type ProviderErrorCode } from "@armada/core";
import { refusal } from "./errors.ts";
import type { Machine, RunnerTransport } from "./ports.ts";
export interface RunnerAccess {
  url: string;
  connectToken: string;
  grant: string;
  expiresAt: number;
}
const errors: Record<string, ProviderErrorCode> = {
  invalid_request: "invalid_request",
  invalid_mcp_configuration: "invalid_request",
  mcp_revision_conflict: "conflict",
  stale_mcp_revision: "conflict",
  mcp_revision_limit: "conflict",
  builder_credentials_forbidden: "invalid_request",
  builder_model_prompts_forbidden: "invalid_request",
  invalid_exec_environment: "invalid_request",
  conflict: "conflict",
  forbidden: "forbidden",
  sandbox_not_ready: "sandbox_not_ready",
  unauthorized: "unauthorized",
  not_found: "not_found",
  no_running_turn: "no_running_turn",
  conversation_busy: "conflict",
  checkpoint_in_progress: "sandbox_not_ready",
  checkpoint_upstream_unacknowledged: "conflict",
  request_outcome_unknown: "conflict",
  conversation_harness_mismatch: "invalid_request",
  unsupported_fast_model: "invalid_request",
  invalid_effort: "invalid_request",
};
/** Real protocol1 supports string errors on 409 without an envelope; successful responses must match
 * request identity. Error details are allowlisted, never copied into public diagnostics. */
export function createRunnerTransport(
  access: (row: Machine) => Promise<RunnerAccess>,
  fetcher: typeof fetch = fetch,
): RunnerTransport {
  return {
    async call<T>(row: Machine, op: string, input: object): Promise<T> {
      const connection = await access(row);
      if (connection.expiresAt <= Date.now()) throw refusal("unauthorized", "Runner grant expired.");
      const requestId = randomUUID();
      const exec = input as { input?: { timeoutSeconds?: number; detached?: boolean } };
      const budget =
        op === "exec" && !exec.input?.detached
          ? ((exec.input?.timeoutSeconds ?? 3600) + 30) * 1000
          : op === "health"
            ? 5000
            : 120_000;
      const response = await fetcher(connection.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${connection.connectToken}`,
          "x-armada-runner-grant": connection.grant,
        },
        body: JSON.stringify({ ...input, version: 1, requestId, sandboxId: row.info.id, op }),
        signal: AbortSignal.timeout(Math.min(budget, Math.max(1, connection.expiresAt - Date.now()))),
      });
      if (response.status !== 409 && !response.ok)
        throw refusal(response.status === 401 ? "unauthorized" : "unavailable", "Runner transport refused request.");
      const envelope = (await response.json()) as {
        version?: number;
        requestId?: string;
        result?: T;
        error?: string | { code: string };
      };
      const identified = envelope.version !== undefined || envelope.requestId !== undefined;
      if (identified && (envelope.version !== 1 || envelope.requestId !== requestId))
        throw refusal("unavailable", "Runner response identity mismatch.");
      if (envelope.error) {
        // Existing protocol1 handlers use a bare safe error on HTTP409; successful/enveloped
        // responses (including enveloped errors) must identify this exact request/version.
        if (!identified && response.status !== 409) throw refusal("unavailable", "Runner response identity mismatch.");
        const name = typeof envelope.error === "string" ? envelope.error : envelope.error.code;
        throw new ProviderError({
          provider: "modal",
          code: errors[name] ?? "unknown",
          message: "Runner operation refused.",
          retryable: false,
        });
      }
      if (!response.ok || envelope.version !== 1 || envelope.requestId !== requestId)
        throw refusal("unavailable", "Runner response identity mismatch.");
      return envelope.result as T;
    },
  };
}
