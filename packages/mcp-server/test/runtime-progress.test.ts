import { expect, spyOn, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import { observeRequest } from "../src/request-observability.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeProgress } from "../src/runtime-progress.ts";
import { ENCRYPTION_KEY } from "./support.ts";

// Untrusted progress must be rejected before authority lookup or fixed-stage logging.
test("malformed progress refuses extra fields, unknown stages and oversized bodies before SQL or logging", async () => {
  let queries = 0;
  const sql: Sql = {
    async query() {
      queries++;
      throw Error("Invalid progress must not query authority");
    },
  };
  const report = createRuntimeProgress(createRuntimeEnrolments(sql, ENCRYPTION_KEY));
  const log = spyOn(console, "info").mockImplementation(() => {});
  try {
    const bodies = [
      null,
      [],
      {},
      { stage: "bootstrap_started", secret: "private_config_canary" },
      { stage: "private_config_canary" },
      { stage: 1 },
      { stage: "runtime_failed", reason: "private_config_canary" },
      { stage: "harness_turn_failed", diagnostic: { errorClass: "private_config_canary", stack: [] } },
      { stage: "harness_start_failed", diagnostic: { errorClass: "HarnessError", stack: ["private_config_canary"] } },
      { stage: "enrolled", reason: "artifact_preparation" },
    ].map((value) => JSON.stringify(value));
    bodies.push(`${" ".repeat(1024)}{"stage":"bootstrap_started"}`);
    for (const body of bodies) {
      const response = await report(
        new Request("https://armada.test/api/runtime/progress", {
          method: "POST",
          headers: { authorization: "Bearer private_progress_canary" },
          body,
        }),
      );
      expect(response?.status).toBe(400);
      expect(await response?.json()).toEqual({ error: "runtime_progress_refused" });
    }
    expect(queries).toBe(0);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test("authenticated startup sub-reason is persisted and logged without exception text", async () => {
  const writes: unknown[][] = [];
  const scope = { sandboxId: crypto.randomUUID(), epoch: "1" };
  const authority = {
    async withSession(
      _token: string,
      _epoch: string,
      apply: (tx: Sql, scope: { sandboxId: string; epoch: string }) => Promise<unknown>,
    ) {
      return apply(
        {
          async query(_sql: string, values: unknown[]) {
            writes.push(values);
            return { rows: [] };
          },
        },
        scope,
      );
    },
  } as unknown as ReturnType<typeof createRuntimeEnrolments>;
  const log = spyOn(console, "info").mockImplementation(() => {});
  try {
    const route = createRuntimeProgress(authority);
    const records: unknown[] = [];
    const report = (body: Record<string, unknown>) =>
      observeRequest(
        async () =>
          (await route(
            new Request("https://armada.test/api/runtime/progress", {
              method: "POST",
              body: JSON.stringify(body),
            }),
          )) ?? undefined,
        (line) => records.push(JSON.parse(line)),
      );
    const response = await report({ stage: "runtime_failed", reason: "artifact_preparation" });
    const harness = await report({
      stage: "harness_turn_failed",
      diagnostic: { errorClass: "HarnessError", stack: ["codex.ts:701:12"], reason: "session_start_failed" },
    });
    expect(harness?.status).toBe(200);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "operator_failure",
          phase: "runtime.boot",
          message: "artifact_preparation",
          requestId: response?.headers.get("x-request-id"),
          sandboxId: scope.sandboxId,
        }),
        expect.objectContaining({
          event: "operator_failure",
          phase: "runtime.harness_turn_failed",
          errorClass: "HarnessError",
          message: "session_start_failed",
          stack: ["codex.ts:701:12"],
          requestId: harness?.headers.get("x-request-id"),
          sandboxId: scope.sandboxId,
        }),
      ]),
    );
    expect(response?.status).toBe(200);
    expect(writes).toEqual([
      [
        scope.sandboxId,
        "Runtime artifact preparation failed. Ask the server operator to check published harness artifacts and container filesystem access before launching again.",
      ],
    ]);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      stage: "runtime_failed",
      reason: "artifact_preparation",
    });
  } finally {
    log.mockRestore();
  }
});
