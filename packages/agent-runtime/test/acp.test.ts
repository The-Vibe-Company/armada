import { expect, test } from "bun:test";
import { AcpDriver, type DriverEvent } from "../src/index.ts";

// The real stdio transport owns load replay, cancel-response races and multi-turn usage attribution.
// The existing Runner tests cannot observe wire behavior inside a native harness process.
for (const action of ["finish", "steer", "interrupt", "unknown"] as const) {
  test(`ACP v1 ${action} preserves session identity and native usage without replay`, async () => {
    const driver = new AcpDriver({
      executable: process.execPath,
      args: ["run", `${import.meta.dir}/fixtures/acp.ts`],
      cwd: "/tmp",
      env: {},
    });
    const events: DriverEvent[] = [];
    let observed!: () => void;
    const emitted = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const context = {
      request: {
        sandboxId: "s",
        harness: "opencode" as const,
        text: action === "steer" || action === "interrupt" ? "hold" : action === "finish" ? "DOCKER_OK" : action,
        model: "test/model",
      },
      sessionId: "session-1",
      signal: new AbortController().signal,
      emit: (event: DriverEvent) => {
        events.push(event);
        if (event.kind === "message") observed();
      },
      session: (id: string) => expect(id).toBe("session-1"),
    };
    try {
      await driver.resumeSession({ ...context });
      expect(events).toEqual([]);
      const turn = driver.start(context);
      await emitted;
      if (action === "steer") await turn.steer("next");
      if (action === "interrupt") await turn.interrupt();
      expect(await turn.done).toBe(action === "interrupt" ? "interrupted" : "finished");
      expect(
        events
          .filter((e): e is Extract<DriverEvent, { kind: "message" }> => e.kind === "message" && e.partial)
          .map((e) => e.text),
      ).toEqual(
        action === "steer"
          ? ["hold", "next"]
          : action === "finish"
            ? ["D", "OCK", "ER", "_OK"]
            : [context.request.text],
      );
      const finals = events.filter((event) => event.kind === "message" && !event.partial);
      expect(finals.map((event) => (event.kind === "message" ? event.text : ""))).toEqual(
        action === "interrupt" ? [] : [action === "steer" ? "next" : context.request.text],
      );
      if (finals[0]?.kind === "message") {
        expect(finals[0].messageId).toEqual(expect.any(String));
        const lastChunk = events.findLast((event) => event.kind === "message" && event.partial);
        expect(finals[0]).toMatchObject({
          textMode: "snapshot",
          messageId: lastChunk?.kind === "message" ? lastChunk.messageId : undefined,
        });
      }
      const usage = events.filter((e) => e.kind === "other" && e.type === "armada/turnUsage");
      expect(usage).toHaveLength(1);
      expect(usage[0]?.kind === "other" ? usage[0].data : undefined).toMatchObject({
        model: "test/model",
        inputTokens: action === "steer" ? 7 : action === "interrupt" ? 4 : action === "unknown" ? null : 3,
        outputTokens: action === "steer" ? 3 : action === "interrupt" ? 1 : action === "unknown" ? null : 2,
      });
    } finally {
      await driver.close();
    }
  });
}
test("ACP names a turn cut by the model output limit instead of a configuration failure", async () => {
  const driver = new AcpDriver({
    executable: process.execPath,
    args: ["run", `${import.meta.dir}/fixtures/acp.ts`],
    cwd: "/tmp",
    env: {},
  });
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "opencode", text: "output-limit" },
      signal: new AbortController().signal,
      emit: () => {},
      session: () => {},
    });
    await expect(turn.done).rejects.toMatchObject({ code: "output_limit_exceeded" });
  } finally {
    await driver.close();
  }
});

test("ACP refuses another protocol before dispatching a prompt", async () => {
  const driver = new AcpDriver({
    executable: process.execPath,
    args: ["run", `${import.meta.dir}/fixtures/acp.ts`],
    cwd: "/tmp",
    env: { BAD_ACP: "1" },
  });
  try {
    await expect(
      driver.start({
        request: { sandboxId: "s", harness: "codex", text: "no" },
        signal: new AbortController().signal,
        emit: () => {
          throw Error("unexpected event");
        },
        session: () => {
          throw Error("unexpected session");
        },
      }).done,
    ).rejects.toThrow("invalid_harness_protocol");
  } finally {
    await driver.close();
  }
});

// A failed native telemetry channel cannot silently leave the active prompt running without wait visibility.
test("ACP observes native events before prompt and releases the observer when its stream fails", async () => {
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  let ready = false;
  let closed = false;
  const driver = new AcpDriver({
    executable: process.execPath,
    args: ["run", `${import.meta.dir}/fixtures/acp.ts`],
    cwd: "/tmp",
    env: {},
    observation: {
      ready: async (sessionId) => {
        expect(sessionId).toBe("session-1");
        ready = true;
      },
      failed,
      close: async () => {
        closed = true;
      },
    },
  });
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "opencode", text: "hold" },
      signal: new AbortController().signal,
      session: () => {},
      emit: (event) => {
        if (event.kind === "message") {
          expect(ready).toBe(true);
          rejectFailure(new Error("observer_lost"));
        }
      },
    });
    await expect(turn.done).rejects.toThrow("observer_lost");
    expect(closed).toBe(true);
  } finally {
    await driver.close();
  }
});

// Definite pre-side-effect refusal at the driver boundary: no continuation exists to steer.
test("ACP refuses a steer after its turn stopped with a replayable refusal", async () => {
  const driver = new AcpDriver({
    executable: process.execPath,
    args: ["run", `${import.meta.dir}/fixtures/acp.ts`],
    cwd: "/tmp",
    env: {},
  });
  try {
    const turn = driver.start({
      request: { sandboxId: "s", harness: "opencode", text: "DOCKER_OK", model: "test/model" },
      signal: new AbortController().signal,
      emit: () => {},
      session: () => {},
    });
    expect(await turn.done).toBe("finished");
    const { RequestRefused } = await import("../src/errors.ts");
    await expect(turn.steer("too-late")).rejects.toBeInstanceOf(RequestRefused);
  } finally {
    await driver.close();
  }
});
