import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_HEADER, type Driver, type DriverContext, Journal, Runner } from "../src/index.ts";

const token1 = `armada_epoch_${"a".repeat(64)}`,
  token2 = `armada_epoch_${"b".repeat(64)}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const grant = {
  token: "private-runner-fixture-grant",
  sandboxId: "parent",
  generation: "physical-1",
};
async function call(runner: Runner, op: string, extra: Record<string, unknown> = {}, bearer = grant.token) {
  return runner.handle(
    new Request("https://runner.invalid", {
      method: "POST",
      headers: { [AUTH_HEADER]: bearer },
      body: JSON.stringify({ version: 1, sandboxId: grant.sandboxId, requestId: crypto.randomUUID(), op, ...extra }),
    }),
  );
}
const install = (epoch: string, token = token1, generation = grant.generation) => ({
  token,
  binding: { epoch, physicalGeneration: generation },
  url: "https://armada.invalid/private/orchestrator-mcp",
});

// Owns private RPC admission/ACK, reordered delivery, immutable active client snapshot
// and durable scrub boundary. This is NOT provider/native-client conformance proof.
test("private epoch ACK is generation/monotonic fenced; stale scrub preserves newer authority and checkpoint requires scrub", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-epoch-"));
  const journal = new Journal(join(root, "journal.sqlite"), (s) => s);
  const contexts: DriverContext[] = [];
  let finish: () => void = () => {};
  const driver: Driver = {
    start(context) {
      contexts.push(context);
      context.session("native-fixture");
      const done = new Promise<"finished" | "interrupted">((resolve) => {
        finish = () => resolve("finished");
      });
      return {
        done,
        interrupt: async () => {
          finish();
        },
        steer: async () => {},
      };
    },
    close: async () => {},
  };
  const activeGrant = { ...grant, expiresAt: Date.now() + 60_000 };
  const runner = new Runner(
    journal,
    activeGrant,
    { claude: driver, codex: driver },
    { append: async (batch) => ({ acknowledgedSequence: batch.events.at(-1)?.sequence ?? 0 }) },
  );
  try {
    expect((await call(runner, "installOrchestratorEpoch", install("1"), "wrong-runner-grant")).status).toBe(401);
    expect((await call(runner, "installOrchestratorEpoch", install("1", token1, "old-generation"))).status).toBe(409);
    const ack = await call(runner, "installOrchestratorEpoch", install("1"));
    expect(ack.status).toBe(200);
    expect(await ack.json()).toMatchObject({ result: { acknowledged: true } });
    expect((await call(runner, "installOrchestratorEpoch", install("2", token2))).status).toBe(200);
    expect((await call(runner, "installOrchestratorEpoch", install("1"))).status).toBe(409);
    expect(
      (await call(runner, "installOrchestratorEpoch", { ...install("2", token2), url: "https://other.invalid/mcp" }))
        .status,
    ).toBe(409);
    expect((await call(runner, "scrubOrchestratorEpoch", { tokenHash: hash(token1) })).status).toBe(200);
    const turn = await call(runner, "prompt", { input: { sandboxId: "parent", harness: "claude", text: "first" } });
    expect(turn.status).toBe(200);
    const receipt = ((await turn.json()) as { result: { promptId: string; conversationId: string } }).result;
    const observed = await call(runner, "observeOrchestrator", { conversationId: receipt.conversationId });
    expect(observed.status).toBe(200);
    const snapshot = (await observed.json()) as {
      result: { state: string; nativeSessionId: string; evidence: string; physicalGeneration: string };
    };
    expect(snapshot.result.state).toBe("active");
    expect(snapshot.result.nativeSessionId).toBe("native-fixture");
    expect(snapshot.result.evidence).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.result.physicalGeneration).toBe(grant.generation);
    const connection = contexts[0]?.mcp?.servers.armada_orchestrator;
    expect(connection?.type === "http" && connection.headers?.Authorization).toBe(`Bearer ${token2}`);
    expect((await call(runner, "installOrchestratorEpoch", install("3"))).status).toBe(409);
    expect((await call(runner, "scrubOrchestratorEpoch", { tokenHash: hash(token2) })).status).toBe(409);
    expect((await call(runner, "checkpoint")).status).toBe(409);
    finish();
    await call(runner, "getPrompt", { promptId: receipt.promptId });
    expect((await call(runner, "scrubOrchestratorEpoch", { tokenHash: hash(token2) })).status).toBe(200);
    expect((await call(runner, "installOrchestratorEpoch", install("2", token2))).status).toBe(409);
    const saved = JSON.stringify(journal.db.query("SELECT * FROM metadata").all());
    const requests = JSON.stringify(journal.db.query("SELECT * FROM requests").all());
    for (const value of [token1, token2]) {
      expect(saved).not.toContain(value);
      expect(requests).not.toContain(value);
      expect(journal.redact(value)).not.toContain(value);
    }
    expect((await call(runner, "checkpoint")).status).toBe(200);
    const restarted = new Runner(journal, activeGrant, { claude: driver, codex: driver });
    expect((await call(restarted, "installOrchestratorEpoch", install("2", token2))).status).toBe(409);
  } finally {
    finish();
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});
