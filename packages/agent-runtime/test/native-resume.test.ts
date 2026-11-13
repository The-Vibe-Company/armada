import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_HEADER, ClaudeDriver, CodexDriver, type Driver, Journal, Runner } from "../src/index.ts";

// Real private Runner RPC + native JSONL subprocess: no fake driver can echo proof.
test("private native resume verifies the persisted session without prompt/events and denies absent or cross-harness identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-native-resume-"));
  const journal = new Journal(":memory:", (s) => s);
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
  const journal = new Journal(":memory:", (s) => s);
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

// Actual604 RunnerExecutionOptions ABI: synchronous redactor refresh and async private publication.
test("native no-text ACK preserves actual credential lifecycle hooks and refuses failed publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-resume-auth-"));
  const journal = new Journal(":memory:", (s) => s);
  const order: string[] = [];
  let fail = false;
  const driver: Driver = {
    start: () => {
      throw Error("No turn allowed.");
    },
    resumeSession: async () => {
      order.push("native");
      return { sessionId: "native" };
    },
    close: async () => {},
  };
  const grant = {
    token: "synthetic-private-runner-token",
    sandboxId: "s",
    generation: "2",
    expiresAt: Date.now() + 60000,
  };
  const execution = {
    credentialFreeBuilder: false,
    refreshNativeSecrets: () => {
      order.push("refresh");
    },
    publishNativeAuth: async () => {
      order.push("publish");
      if (fail) throw Error("untrusted publication text must not escape");
    },
  };
  const runner = new Runner(
    journal,
    grant,
    { codex: driver, claude: driver },
    undefined,
    undefined,
    undefined,
    execution,
  );
  journal.saveSession("logical", "codex", "native");
  const resume = () =>
    runner.handle(
      new Request("https://runner.invalid", {
        method: "POST",
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({
          version: 1,
          requestId: crypto.randomUUID(),
          sandboxId: "s",
          op: "resumeNativeSession",
          conversationId: "logical",
          expectedSessionId: "native",
          input: { sandboxId: "s", harness: "codex", model: "gpt-6.1-sol" },
        }),
      }),
    );
  try {
    expect((await resume()).status).toBe(200);
    expect(order).toEqual(["refresh", "native", "refresh", "publish"]);
    fail = true;
    expect(await (await resume()).json()).toEqual({ error: "native_auth_state_unacknowledged" });
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Claude's no-text handshake must send --resume and fail closed on native rejection.
test("Claude native resume initializes the existing session without creating a user turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-claude-native-resume-"));
  const proof = join(root, "resume-proof.json");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_RESUME_PROOF: proof, ARMADA_CWD_PROOF: "1" };
  const options = { executable: `${import.meta.dir}/fixtures/claude-process.ts`, cwd: root, env };
  const driver = new ClaudeDriver(options);
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const context = {
    sessionId,
    signal: new AbortController().signal,
    request: { sandboxId: "s", harness: "claude" as const, model: "claude-opus-5-5" },
  };
  try {
    expect(await driver.resumeSession(context)).toEqual({ sessionId });
    const observed = JSON.parse(await readFile(proof, "utf8")) as { argv: string[]; cwd: string };
    expect(observed.cwd).toBe(root);
    expect(observed.argv).toContain(`--resume=${sessionId}`);
    expect(await readFile(join(root, "native-cwd-proof.json"), "utf8").catch(() => null)).toBeNull();
    const rejecting = new ClaudeDriver({ ...options, env: { ...env, ARMADA_RESUME_REFUSE: "1" } });
    try {
      await expect(rejecting.resumeSession(context)).rejects.toThrow("native_session_unverified");
    } finally {
      await rejecting.close();
    }
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
