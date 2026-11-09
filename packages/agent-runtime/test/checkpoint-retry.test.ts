import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_HEADER, createRedactor, type Driver, type Grant, HarnessState, Journal, Runner } from "../src/index.ts";

// Owner boundary: real HTTP handler + WAL + native filesystem; no fake checkpoint callback behavior.
test("lost checkpoint response retry and same-generation runner restart retain sealed sessions and admission fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-checkpoint-retry-"));
  const redact = createRedactor([]);
  const state = new HarnessState(root, redact);
  await state.restore();
  await mkdir(join(root, "codex/sessions/test"), { recursive: true });
  const session = `${JSON.stringify({ type: "session_meta", payload: { id: "remembered-thread", word: "lantern" } })}\n`;
  await writeFile(join(root, "codex/sessions/test/thread.jsonl"), session);
  let journal = new Journal(join(root, "journal.sqlite"), redact);
  const grant: Grant = {
    token: "retry-fixture-private-grant",
    sandboxId: "s",
    generation: "g1",
    expiresAt: Date.now() + 60000,
  };
  const unused: Driver = {
    start() {
      throw Error("unexpected_driver_start");
    },
    async close() {},
  };
  const make = (g = grant) =>
    new Runner(journal, g, { claude: unused, codex: unused }, undefined, undefined, () =>
      new HarnessState(root, redact).checkpoint(g),
    );
  const call = (runner: Runner, op: string, requestId = "lost-response", extra: Record<string, unknown> = {}) =>
    runner.handle(
      new Request("https://runner", {
        method: "POST",
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({ version: 1, requestId, sandboxId: "s", op, ...extra }),
      }),
    );
  try {
    const first = make();
    expect((await call(first, "checkpoint")).status).toBe(200);
    // Discard the first response, then retry with the SAME request ID.
    expect((await call(first, "checkpoint")).status).toBe(200);
    expect(await readFile(join(root, "session-state/codex/sessions/test/thread.jsonl"), "utf8")).toBe(session);
    journal.close();
    journal = new Journal(join(root, "journal.sqlite"), redact);
    const restarted = make();
    expect((await call(restarted, "checkpoint")).status).toBe(200);
    const health = (await (await call(restarted, "health", "health")).json()) as { result: { ready: boolean } };
    expect(health.result.ready).toBe(false);
    expect(
      (
        await call(restarted, "prompt", "blocked-prompt", {
          input: { sandboxId: "s", harness: "codex", text: "must not run" },
        })
      ).status,
    ).toBe(409);
    const expired = make({ ...grant, expiresAt: 0 });
    expect((await call(expired, "checkpoint")).status).toBe(401);
    // A fresh generation must regain admission, not inherit an old checkpoint cache.
    const next = make({ ...grant, generation: "g2" });
    expect(
      ((await (await call(next, "health", "fresh-health")).json()) as { result: { ready: boolean } }).result.ready,
    ).toBe(true);
    await state.restore();
    expect(JSON.parse(await readFile(join(root, "codex/sessions/test/thread.jsonl"), "utf8")).payload.word).toBe(
      "lantern",
    );
    await rm(join(root, "codex"), { recursive: true, force: true });
    await mkdir(join(root, "codex"));
    expect((await call(next, "checkpoint")).status).toBe(409);
    expect(
      JSON.parse(await readFile(join(root, "session-state/codex/sessions/test/thread.jsonl"), "utf8")).payload.word,
    ).toBe("lantern");
    await writeFile(join(root, "session-state/codex/sessions/test/thread.jsonl"), "changed-after-seal");
    expect((await call(restarted, "checkpoint")).status).toBe(409);
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});
