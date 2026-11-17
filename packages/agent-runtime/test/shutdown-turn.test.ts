import { expect, test } from "bun:test";
import { HarnessError } from "../src/errors.ts";
import { AUTH_HEADER, type Driver, type Grant, Journal, Runner } from "../src/index.ts";

test("intentional shutdown interrupts pending turns across harnesses while child loss remains failed", async () => {
  for (const harness of ["codex", "claude", "opencode"] as const) {
    for (const shutdown of [true, false]) {
      let reject!: (error: unknown) => void;
      const done = new Promise<"finished">((_, fail) => {
        reject = fail;
      });
      const driver: Driver = {
        start: () => ({ done, interrupt: async () => {}, steer: async () => {} }),
        close: async () => {
          reject(new HarnessError("harness_process_lost"));
        },
      };
      const journal = new Journal(":memory:", (value) => value);
      const grant: Grant = {
        token: "fixture_ephemeral_secret",
        sandboxId: "logical",
        generation: "g1",
        expiresAt: Date.now() + 60000,
      };
      let publish!: () => void;
      let publicationStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        publicationStarted = resolve;
      });
      const publication = new Promise<void>((resolve) => {
        publish = resolve;
      });
      const runner = new Runner(
        journal,
        grant,
        { codex: driver, claude: driver, opencode: driver },
        undefined,
        undefined,
        undefined,
        {
          publishNativeAuth: async () => {
            publicationStarted();
            await publication;
          },
        },
      );

      try {
        const response = await runner.handle(
          new Request("https://runner/v1", {
            method: "POST",
            headers: { [AUTH_HEADER]: grant.token },
            body: JSON.stringify({
              version: 1,
              sandboxId: "logical",
              requestId: "r",
              op: "prompt",
              input: { sandboxId: "logical", harness, text: "hello" },
            }),
          }),
        );
        expect(response.status).toBe(200);
        if (!shutdown) {
          await driver.close();
          await started;
        }
        const closing = runner.close();
        publish();
        await closing;
        expect(journal.prompts()[0]?.status).toBe(shutdown ? "interrupted" : "failed");
      } finally {
        await runner.close();
        journal.close();
      }
    }
  }
});
