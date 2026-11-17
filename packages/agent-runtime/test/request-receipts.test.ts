import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestRefused } from "../src/errors.ts";
import { AUTH_HEADER, CodexDriver, type Driver, Journal, Runner } from "../src/index.ts";
import { executeWithReceipt } from "../src/request-receipts.ts";

test("checkpoint retries dispatch afresh instead of replaying an old request receipt", async () => {
  const journal = new Journal(":memory:", (value) => value);
  try {
    journal.db
      .query("INSERT INTO requests VALUES(?,?)")
      .run("checkpoint_retry", JSON.stringify({ result: { watermark: 1, generation: "old" } }));
    const response = await executeWithReceipt(
      journal,
      { version: 1, sandboxId: "logical", requestId: "checkpoint_retry", op: "checkpoint" },
      async () => ({ watermark: 2, generation: "new" }),
    );
    expect(await response.json()).toEqual({
      version: 1,
      requestId: "checkpoint_retry",
      result: { watermark: 2, generation: "new" },
    });
  } finally {
    journal.close();
  }
});

test("definite refusals replay their status while ambiguous failures retain the crash fence", async () => {
  const journal = new Journal(":memory:", (value) => value);
  try {
    for (const definite of [true, false]) {
      const request = {
        version: 1 as const,
        sandboxId: "logical",
        requestId: String(definite),
        op: "interrupt" as const,
      };
      let calls = 0;
      const dispatch = async () => {
        calls++;
        throw definite ? new RequestRefused("no_running_turn") : Error("transport_lost");
      };
      if (definite) expect((await executeWithReceipt(journal, request, dispatch)).status).toBe(409);
      else await expect(executeWithReceipt(journal, request, dispatch)).rejects.toThrow("transport_lost");
      const replay = await executeWithReceipt(journal, request, dispatch);
      expect(replay.status).toBe(definite ? 409 : 200);
      expect(await replay.json()).toMatchObject({ error: definite ? "no_running_turn" : "request_outcome_unknown" });
      expect(calls).toBe(1);
    }
  } finally {
    journal.close();
  }
});

// Real CodexDriver + local wire peer: a completed turn stays active while auth publication awaits,
// so the steer is refused before any continuation begins. The identical retry must replay the 409.
test("a steer refused while a completed turn awaits auth publication replays its definite status", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-steer-receipt-"));
  const journal = new Journal(":memory:", (value) => value);
  const driver = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  const grant = { token: crypto.randomUUID(), sandboxId: "s", generation: "g", expiresAt: Date.now() + 60000 };
  let release!: () => void;
  const publication = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = Promise.withResolvers<void>();
  let observeStarted = false;
  const runner = new Runner(journal, grant, { codex: driver }, undefined, undefined, undefined, {
    publishNativeAuth: async () => {
      if (!observeStarted) {
        observeStarted = true;
        started.resolve();
      }
      await publication;
    },
  });
  const call = (requestId: string, body: Record<string, unknown>) =>
    runner.handle(
      new Request("https://runner", {
        method: "POST",
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({ version: 1, requestId, sandboxId: "s", ...body }),
      }),
    );
  try {
    const prompt = await call("p", {
      op: "prompt",
      input: { sandboxId: "s", harness: "codex", text: "message-semantics" },
    });
    expect(prompt.status).toBe(200);
    const { conversationId } = (await prompt.json()) as { conversationId: string };
    // Wait for completion while publication is held: the turn is done but still admitted as active.
    await started.promise;
    const steer = { op: "steer", conversationId, text: "next" };
    const first = await call("s", steer);
    expect(first.status).toBe(409);
    expect(await first.json()).toEqual({ error: "no_running_turn" });
    // The retry replays the definite refusal; it never re-dispatches or claims an unknown outcome.
    const retry = await call("s", steer);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ error: "no_running_turn" });
    expect(journal.events().filter((row) => row.event.kind === "steer")).toEqual([]);
  } finally {
    release();
    await runner.close();
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

// A turn that finished but is still admitted while auth publication awaits has nothing to steer.
test("steer refuses an already-terminal admitted turn before the driver is called", async () => {
  const journal = new Journal(":memory:", (value) => value);
  let steerCalls = 0;
  const driver: Driver = {
    start: () => ({
      done: Promise.resolve("finished" as const),
      interrupt: async () => {},
      steer: async () => {
        steerCalls++;
      },
    }),
    close: async () => {},
  };
  const grant = { token: crypto.randomUUID(), sandboxId: "s", generation: "g", expiresAt: Date.now() + 60000 };
  const { promise: publication, resolve: publish } = Promise.withResolvers<void>();
  const { promise: started, resolve: observe } = Promise.withResolvers<void>();
  let observed = false;
  const runner = new Runner(journal, grant, { codex: driver }, undefined, undefined, undefined, {
    publishNativeAuth: async () => {
      if (!observed) {
        observed = true;
        observe();
      }
      await publication;
    },
  });
  const call = (requestId: string, body: Record<string, unknown>) =>
    runner.handle(
      new Request("https://runner", {
        method: "POST",
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({ version: 1, requestId, sandboxId: "s", ...body }),
      }),
    );
  try {
    const prompt = await call("p", { op: "prompt", input: { sandboxId: "s", harness: "codex", text: "hello" } });
    const { conversationId } = (await prompt.json()) as { conversationId: string };
    await started;
    const response = await call("s", { op: "steer", conversationId, text: "next" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_running_turn" });
    expect(steerCalls).toBe(0);
  } finally {
    publish();
    await runner.close();
    journal.close();
  }
});
