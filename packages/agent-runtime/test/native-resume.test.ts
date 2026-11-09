import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_HEADER, CodexDriver, type Driver, Journal, Runner } from "../src/index.ts";

// Real private Runner RPC + native JSONL subprocess: no fake driver can echo proof.
test("private native resume verifies the persisted session without prompt/events and denies absent or cross-harness identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-native-resume-"));
  const journal = new Journal(join(root, "journal.sqlite"), (s) => s);
  const codex = new CodexDriver({
    executable: `${import.meta.dir}/fixtures/app-server.ts`,
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_CWD_PROOF: "1" },
  });
  const unsupported: Driver = {
    start: () => {
      throw Error("No text allowed.");
    },
    close: async () => {},
  };
  const grant = {
    token: "synthetic-private-runner-token",
    sandboxId: "s",
    generation: "native-generation-2",
    expiresAt: Date.now() + 60000,
  };
  const runner = new Runner(journal, grant, { codex, claude: unsupported });
  journal.saveSession("logical", "codex", "saved-native");
  journal.saveSession("claude-logical", "claude", "claude-native");
  const call = (conversationId: string, expectedSessionId: string, harness = "codex", extra = {}) =>
    runner.handle(
      new Request("https://runner.invalid", {
        method: "POST",
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({
          version: 1,
          requestId: crypto.randomUUID(),
          sandboxId: "s",
          op: "resumeNativeSession",
          conversationId,
          expectedSessionId,
          input: { sandboxId: "s", harness, model: harness === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5", ...extra },
        }),
      }),
    );
  try {
    const response = await call("logical", "saved-native");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        verified: true,
        physicalGeneration: grant.generation,
        conversationId: "logical",
        nativeSessionId: "saved-native",
      },
    });
    expect(journal.prompts()).toEqual([]);
    expect(journal.events()).toEqual([]);
    expect((await call("missing", "saved-native")).status).toBe(409);
    expect((await call("logical", "replacement")).status).toBe(409);
    expect((await call("logical", "saved-native", "claude")).status).toBe(409);
    expect(await (await call("claude-logical", "claude-native", "claude")).json()).toEqual({
      error: "native_resume_unsupported",
    });
    expect((await call("logical", "saved-native", "codex", { text: "must not inject a prompt" })).status).toBe(409);
    const records = JSON.parse(await readFile(join(root, "native-cwd-proof.json"), "utf8")) as { method: string }[];
    expect(records.map((r) => r.method)).toEqual(["initialize", "initialized", "thread/resume"]);
    expect(journal.session("logical")).toBe("saved-native");
  } finally {
    await codex.close();
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Owns admission serialization, not native continuity proof (the subprocess test does).
test("native verification serializes prompts, epoch mutation and checkpoint even when a driver fails synchronously", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-native-resume-race-"));
  const journal = new Journal(join(root, "journal.sqlite"), (s) => s);
  let fail = true,
    release!: () => void,
    entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const driver: Driver = {
    start: () => {
      throw Error("Must not admit a prompt during native verification.");
    },
    resumeSession: () => {
      if (fail) {
        fail = false;
        throw Error("synthetic_native_failure");
      }
      entered();
      return new Promise((resolve) => {
        release = () => resolve({ sessionId: "native" });
      });
    },
    close: async () => {},
  };
  const grant = {
    token: "synthetic-private-runner-token",
    sandboxId: "s",
    generation: "2",
    expiresAt: Date.now() + 60000,
  };
  const runner = new Runner(journal, grant, { codex: driver, claude: driver });
  journal.saveSession("logical", "codex", "native");
  const call = (op: string, input = {}) =>
    runner.handle(
      new Request("https://runner.invalid", {
        method: "POST",
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({ version: 1, requestId: crypto.randomUUID(), sandboxId: "s", op, ...input }),
      }),
    );
  const resume = () =>
    call("resumeNativeSession", {
      conversationId: "logical",
      expectedSessionId: "native",
      input: { sandboxId: "s", harness: "codex", model: "gpt-6.1-sol" },
    });
  try {
    expect(await (await resume()).json()).toEqual({ error: "synthetic_native_failure" });
    const proof = resume();
    await waiting;
    expect(
      await (
        await call("prompt", {
          input: { sandboxId: "s", harness: "codex", conversationId: "logical", text: "blocked" },
        })
      ).json(),
    ).toEqual({ error: "native_resume_in_progress" });
    expect(
      (
        await call("installOrchestratorEpoch", {
          token: `armada_epoch_${"a".repeat(64)}`,
          binding: { epoch: "1", physicalGeneration: "2" },
          url: "https://armada.invalid/private/mcp",
        })
      ).status,
    ).toBe(409);
    expect(await (await call("observeOrchestrator")).json()).toMatchObject({ result: { state: "active" } });
    const checkpoint = call("checkpoint");
    let completed = false;
    void checkpoint.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    release();
    expect((await proof).status).toBe(200);
    expect((await checkpoint).status).toBe(200);
    expect(journal.prompts()).toEqual([]);
  } finally {
    release?.();
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});
