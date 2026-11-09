import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_HEADER, type Driver, type Grant, HarnessState, Journal, Runner } from "../src/index.ts";

// Real sealed filesystem clone, not a mocked generation predicate. Builder has no model/native history.
test("sealed builder cloned into a new logical sandbox at generation1 admits prompts while the source identity remains sealed", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-seal-clone-")),
    source = join(root, "builder"),
    fork = join(root, "fork");
  let started = 0;
  const driver: Driver = {
    start() {
      started++;
      return { done: Promise.resolve("finished"), async interrupt() {}, async steer() {} };
    },
    async close() {},
  };
  const base = {
    token: "clone-fixture-private-grant",
    sandboxId: "source-builder",
    generation: "1",
    expiresAt: Date.now() + 60000,
  };
  const open = async (path: string, grant: Grant) => {
    const journal = new Journal(join(path, "journal.sqlite"), (s) => s);
    try {
      const state = new HarnessState(path, journal.redact);
      const sourceIdentity = journal.assertRestoreSource(grant);
      if (!journal.checkpointPending(grant)) await state.restore(grant, sourceIdentity);
      const runner = new Runner(
        journal,
        grant,
        { claude: driver, codex: driver },
        {
          async append(batch) {
            return { acknowledgedSequence: batch.events.at(-1)?.sequence ?? 0 };
          },
        },
        undefined,
        () => state.checkpoint(grant),
      );
      return { journal, runner };
    } catch (error) {
      journal.close();
      throw error;
    }
  };
  const { mkdir } = await import("node:fs/promises");
  await mkdir(source);
  const call = (runner: Runner, grant: Grant, op: string, extra: Record<string, unknown> = {}) =>
    runner.handle(
      new Request("https://runner", {
        method: "POST",
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({ version: 1, sandboxId: grant.sandboxId, requestId: crypto.randomUUID(), op, ...extra }),
      }),
    );
  let live: Awaited<ReturnType<typeof open>> | undefined;
  try {
    live = await open(source, base);
    expect(
      ((await (await call(live.runner, base, "health")).json()) as { result: { ready: boolean } }).result.ready,
    ).toBe(true);
    live.journal.flush();
    const unsafe = join(root, "not-quiescent");
    await cp(source, unsafe, { recursive: true });
    await expect(open(unsafe, { ...base, sandboxId: "unsafe-new-id" })).rejects.toThrow(
      "checkpoint_source_not_quiescent",
    );
    expect((await call(live.runner, base, "checkpoint")).status).toBe(200);
    expect((await call(live.runner, base, "checkpoint")).status).toBe(200);
    live.journal.close();
    live = undefined;
    await cp(source, fork, { recursive: true });
    const cloneGrant = { ...base, sandboxId: "new-logical-fork", token: "new-clone-fixture-private-grant" };
    live = await open(fork, cloneGrant);
    expect((await call(live.runner, { ...cloneGrant, token: base.token }, "health")).status).toBe(401);
    expect(
      ((await (await call(live.runner, cloneGrant, "health")).json()) as { result: { ready: boolean } }).result.ready,
    ).toBe(true);
    expect(
      (
        await call(live.runner, cloneGrant, "prompt", {
          input: { sandboxId: cloneGrant.sandboxId, harness: "codex", text: "first turn" },
        })
      ).status,
    ).toBe(200);
    expect(started).toBe(1);
    expect((await call(live.runner, cloneGrant, "checkpoint")).status).toBe(200);
    expect(JSON.parse(await readFile(join(fork, "session-state/.checkpoint.json"), "utf8")).identity).toEqual({
      sandboxId: cloneGrant.sandboxId,
      generation: "1",
    });
    expect((await call(live.runner, cloneGrant, "checkpoint")).status).toBe(200);
    live.journal.close();
    live = undefined;
    const dirty = join(root, "not-a-golden");
    await cp(fork, dirty, { recursive: true });
    await expect(open(dirty, { ...base, sandboxId: "history-fork" })).rejects.toThrow(
      "golden_runner_history_not_empty",
    );
    live = await open(source, base);
    expect(
      ((await (await call(live.runner, base, "health")).json()) as { result: { ready: boolean } }).result.ready,
    ).toBe(false);
    expect(
      (
        await call(live.runner, base, "prompt", {
          input: { sandboxId: base.sandboxId, harness: "claude", text: "must stay blocked" },
        })
      ).status,
    ).toBe(409);
    expect((await call(live.runner, base, "checkpoint")).status).toBe(200);
    live.journal.close();
    live = undefined;
    const next = { ...base, generation: "2", token: "next-generation-fixture-private-grant" };
    live = await open(source, next);
    expect(
      ((await (await call(live.runner, next, "health")).json()) as { result: { ready: boolean } }).result.ready,
    ).toBe(true);
    expect(
      (
        await call(live.runner, next, "prompt", {
          input: { sandboxId: next.sandboxId, harness: "claude", text: "fresh generation" },
        })
      ).status,
    ).toBe(200);
    expect(started).toBe(2);
  } finally {
    await new Promise<void>((r) => setImmediate(r));
    live?.journal.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("a new logical identity cannot import native history, while a new generation of its owner preserves it", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "armada-native-clone-"));
  const source = join(root, "source"),
    target = join(root, "target");
  await mkdir(source);
  const grant: Grant = {
    token: "native-clone-fixture-private-grant",
    sandboxId: "native-owner",
    generation: "1",
    expiresAt: Date.now() + 60000,
  };
  const journal = new Journal(join(source, "journal.sqlite"), (s) => s);
  const state = new HarnessState(source, journal.redact);
  await state.restore(grant);
  const driver: Driver = {
    start() {
      throw Error("unused");
    },
    async close() {},
  };
  const runner = new Runner(journal, grant, { claude: driver, codex: driver }, undefined, undefined, () =>
    state.checkpoint(grant),
  );
  try {
    await mkdir(join(source, "codex/sessions/test"), { recursive: true });
    await writeFile(
      join(source, "codex/sessions/test/thread.jsonl"),
      JSON.stringify({ type: "fixture", word: "lantern" }),
    );
    const response = await runner.handle(
      new Request("https://runner", {
        method: "POST",
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({ version: 1, requestId: "seal", sandboxId: grant.sandboxId, op: "checkpoint" }),
      }),
    );
    expect(response.status).toBe(200);
    journal.flush();
    await cp(source, target, { recursive: true });
    const clone = new HarnessState(target, (s) => s);
    await expect(
      clone.restore({ ...grant, sandboxId: "another-logical-id" }, journal.assertRestoreSource(grant)),
    ).rejects.toThrow("golden_native_history_not_empty");
    await state.restore({ ...grant, generation: "2" }, journal.assertRestoreSource({ ...grant, generation: "2" }));
    expect(JSON.parse(await readFile(join(source, "codex/sessions/test/thread.jsonl"), "utf8")).word).toBe("lantern");
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy generation-only seals fail closed rather than being adopted by a new logical sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-legacy-seal-"));
  const journal = new Journal(join(root, "journal.sqlite"), (s) => s);
  const driver: Driver = {
    start() {
      throw Error("unused");
    },
    async close() {},
  };
  try {
    journal.db.query("INSERT INTO metadata VALUES(?,?)").run("checkpoint:1", "complete");
    expect(
      () =>
        new Runner(
          journal,
          {
            token: "legacy-fixture-private-grant",
            sandboxId: "new-id",
            generation: "1",
            expiresAt: Date.now() + 60000,
          },
          { claude: driver, codex: driver },
        ),
    ).toThrow("checkpoint_identity_ambiguous");
    expect(
      (journal.db.query("SELECT value FROM metadata WHERE key=?").get("checkpoint:1") as { value: string }).value,
    ).toBe("complete");
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});
