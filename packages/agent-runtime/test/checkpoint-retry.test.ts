import { expect, test } from "bun:test";
import { AUTH_HEADER, type Driver, Journal, Runner } from "../src/index.ts";

test("checkpoint retries recompute the receipt while sealed identities retain admission fences", async () => {
  const journal = new Journal(":memory:", (text) => text);
  const grant = {
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
    new Runner(
      journal,
      g,
      { claude: unused, codex: unused },
      {
        async append(batch) {
          return { acknowledgedSequence: batch.events.at(-1)?.sequence ?? 0 };
        },
      },
    );
  const call = (runner: Runner, op: string, extra: Record<string, unknown> = {}) =>
    runner.handle(
      new Request("https://runner", {
        method: "POST",
        headers: { [AUTH_HEADER]: grant.token },
        body: JSON.stringify({
          version: 1,
          requestId: op === "checkpoint" ? "same-checkpoint" : crypto.randomUUID(),
          sandboxId: "s",
          op,
          ...extra,
        }),
      }),
    );
  try {
    const runner = make();
    expect(await (await call(runner, "checkpoint")).json()).toMatchObject({ result: { watermark: 0 } });
    // A late journal tail must not be hidden by a cached success for this request ID.
    journal.append({ id: "late", at: 1, kind: "other", type: "late-event", data: {} });
    expect(await (await call(runner, "checkpoint")).json()).toMatchObject({
      result: { watermark: 1, acknowledgedSequence: 1 },
    });
    const restarted = make();
    expect(await (await call(restarted, "health")).json()).toMatchObject({ result: { ready: false } });
    const blocked = await call(restarted, "prompt", {
      input: { sandboxId: "s", harness: "codex", text: "must not run" },
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "checkpoint_in_progress" });
    expect((await call(make({ ...grant, expiresAt: 0 }), "checkpoint")).status).toBe(401);
    expect(await (await call(make({ ...grant, generation: "g2" }), "health")).json()).toMatchObject({
      result: { ready: true },
    });
  } finally {
    journal.close();
  }
});
