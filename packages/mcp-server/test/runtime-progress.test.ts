import { expect, spyOn, test } from "bun:test";
import type { Sql } from "@armada/core/server";
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
