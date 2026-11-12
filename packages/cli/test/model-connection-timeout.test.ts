import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { productionAuthIo } from "../src/auth-commands.ts";
import { control } from "../src/control.ts";
import { run } from "../src/run.ts";

test("CLI receives the runtime's 15-second outcome rather than timing out at the generic 10-second budget", async () => {
  const timers: { milliseconds: number; controller: AbortController }[] = [];
  const timer = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    timers.push({ milliseconds, controller });
    return controller.signal;
  });
  const out: string[] = [],
    err: string[] = [];
  const auth = productionAuthIo(
    { out: (text) => out.push(text), err: (text) => err.push(text) },
    { ARMADA_URL: "https://armada.example", ARMADA_TOKEN: randomUUID() },
  );
  auth.fetch = (async (_input, init) => {
    // Advance a fake clock to the runtime deadline, without any wall-clock sleep.
    for (const entry of timers) if (entry.milliseconds <= 15000) entry.controller.abort();
    init?.signal?.throwIfAborted();
    return Response.json({ id: "sandbox", test: { ok: false, status: null, error: "connection_failed", code: null } });
  }) as typeof fetch;
  try {
    // Negative control: the old call without a probe-specific signal expires.
    await expect(
      control(auth, "sandbox/test-model-connection", { id: "sandbox", model: "deployment" }),
    ).rejects.toThrow();
    expect(
      await run(
        ["creds", "test", "sandbox", "--model", "deployment", "--json"],
        { out: auth.out, err: auth.err },
        { auth },
      ),
    ).toBe(1);
    expect(out.join("")).toBe(
      JSON.stringify({ id: "sandbox", ok: false, status: null, error: "connection_failed", code: null }) + "\n",
    );
    expect(err).toEqual([]);
  } finally {
    timer.mockRestore();
  }
});
