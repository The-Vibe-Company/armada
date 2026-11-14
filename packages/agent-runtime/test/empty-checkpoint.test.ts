import { expect, test } from "bun:test";
import { AUTH_HEADER, Journal, Runner } from "../src/index.ts";

// Actual guest sealing, not a fabricated restore flag. Empty must not mean fresh
// or rolled-back storage, and hidden native history cannot become a first turn.
test("empty restore requires the exact sealed journal and refuses any native conversation", async () => {
  const grant = {
    sandboxId: "empty",
    generation: "1",
    token: "offline-empty-checkpoint",
    expiresAt: Date.now() + 60000,
  };
  const journal = new Journal(":memory:", (value) => value);
  try {
    const runner = new Runner(journal, grant, {});
    expect(() => journal.requireCheckpoint(grant, 0, null)).toThrow("resume_checkpoint_mismatch");
    const response = await runner.handle(
      new Request("https://runtime/v1", {
        method: "POST",
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({ version: 1, sandboxId: grant.sandboxId, requestId: "seal", op: "checkpoint" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(() => journal.requireCheckpoint(grant, 0, null)).not.toThrow();
    expect(() => journal.requireCheckpoint(grant, 1, null)).toThrow("resume_checkpoint_mismatch");
    journal.saveSession("hidden", "codex", "native-thread");
    expect(() => journal.requireCheckpoint(grant, 0, null)).toThrow("resume_checkpoint_mismatch");
  } finally {
    journal.close();
  }
});
