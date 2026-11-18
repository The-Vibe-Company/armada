import { expect, spyOn, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import { runtimeOperatorDiagnostic } from "../../core/src/runtime-operator-diagnostic.ts";
import { observeRequest } from "../src/request-observability.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeProgress } from "../src/runtime-progress.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
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

const database = rowOnlyDatabase();
test("authenticated boot and turn diagnostics retain their initiating request IDs and sanitized stack", async () => {
  const f = await runtimeFixture(await database(), "boat", "codex", true);
  const records: Record<string, unknown>[] = [];
  const log = (line: string) => records.push(JSON.parse(line));
  const stageLog = spyOn(console, "info").mockImplementation(() => {});
  try {
    let grant = f.active;
    const launch = await observeRequest(async () => {
      const ticket = await f.authority.issue({ ownerId: f.people.owner, sandboxId: f.row.id, configuration: {} });
      grant = await f.authority.enrol(ticket.enrolmentToken);
      return new Response(null, { status: 204 });
    }, log);
    const commandId = "follow_progress_fixture";
    const command = {
      version: 1 as const,
      sandboxId: f.row.id,
      requestId: commandId,
      op: "prompt" as const,
      input: { sandboxId: f.row.id, harness: "codex" as const, text: "fixture prompt" },
    };
    const accept = () =>
      observeRequest(async () => {
        await f.bridge.enqueue(f.people.owner, command);
        return new Response(null, { status: 204 });
      }, log);
    const send = await accept();
    const replay = await accept();
    expect(replay?.headers.get("x-request-id")).not.toBe(send?.headers.get("x-request-id"));
    const route = createRuntimeProgress(f.authority);
    const report = (body: unknown) =>
      observeRequest(
        async () =>
          (await route(
            new Request("https://armada.test/api/runtime/progress", {
              method: "POST",
              headers: { authorization: `Bearer ${grant.runtimeToken}`, "x-armada-runtime-epoch": grant.epoch },
              body: JSON.stringify(body),
            }),
          )) ?? undefined,
        log,
      );
    const error = new Error("private_config_canary");
    error.stack +=
      "\n    at main (/private_config_canary/runtime/main.js:701:12)\n    at /$bunfs/root/armada-runtime:801:19";
    const diagnostic = runtimeOperatorDiagnostic(error, "session_start_failed");
    const unrelated = await report({ stage: "harness_turn_failed", commandId: "foreign_command", diagnostic });
    expect(unrelated?.status).toBe(400);
    const harness = await report({ stage: "harness_turn_failed", commandId, diagnostic });
    expect(harness?.status).toBe(200);
    const boot = await report({ stage: "runtime_failed", reason: "artifact_preparation" });
    expect(boot?.status).toBe(200);
    expect(records.filter((record) => record.event === "operator_failure")).toMatchObject([
      {
        phase: "runtime.harness_turn_failed",
        errorClass: "HarnessError",
        message: "session_start_failed",
        stack: ["main.js:701:12", "armada-runtime:801:19"],
        requestId: send?.headers.get("x-request-id"),
        sandboxId: f.row.id,
      },
      {
        phase: "runtime.boot",
        message: "artifact_preparation",
        requestId: launch?.headers.get("x-request-id"),
        sandboxId: f.row.id,
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("private_config_canary");
    expect((await f.db.query("select status,status_reason from sandboxes where id=$1", [f.row.id])).rows).toEqual([
      {
        status: "failed",
        status_reason:
          "Runtime artifact preparation failed. Ask the server operator to check published harness artifacts and container filesystem access before launching again.",
      },
    ]);
  } finally {
    stageLog.mockRestore();
    await f.close();
  }
});
