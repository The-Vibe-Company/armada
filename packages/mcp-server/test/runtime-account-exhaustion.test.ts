import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { ENCRYPTION_KEY } from "./support.ts";

let f: Awaited<ReturnType<typeof runtimeFixture>>;
beforeAll(async () => {
  f = await runtimeFixture(undefined, "boat", "codex", true);
});
afterAll(async () => f?.close());

test("runtime ACK persists provider exhaustion for the pinned revision and ignores a late older fact", async () => {
  const { append } = createRuntimeEvents(f.authority, ENCRYPTION_KEY);
  const send = (sequence: number, at: number, data: unknown) =>
    append(f.active.runtimeToken, f.active.epoch, {
      sandboxId: f.row.id,
      generation: f.active.epoch,
      events: [
        { sequence, event: { id: String(sequence), at, kind: "other", type: "usage_limit", promptId: "p", data } },
      ],
    });
  const resetsAt = "2027-01-01T14:00:00.000Z";
  await expect(send(1, 200, { code: "usage_limit_exceeded", resetsAt })).resolves.toEqual({
    acknowledgedSequence: 1,
  });
  await expect(send(2, 100, { code: "rate_limited" })).resolves.toEqual({ acknowledgedSequence: 2 });
  expect(
    (await f.db.query("select account_id,credential_version,code,resets_at from account_exhaustion")).rows,
  ).toEqual([
    {
      account_id: f.account.id,
      credential_version: f.account.version,
      code: "usage_limit_exceeded",
      resets_at: new Date(resetsAt),
    },
  ]);
});

test("a mid-turn provider retry leaves the account binding and health intact", async () => {
  const { append } = createRuntimeEvents(f.authority, ENCRYPTION_KEY);
  const readHealth = async () => (await f.db.query("select * from account_exhaustion")).rows;
  const before = await readHealth();
  const { rows: archive } = await f.db.query<{ sequence: string }>(
    "select coalesce(max(sequence),0)::text as sequence from runtime_events where sandbox_id=$1",
    [f.row.id],
  );
  const sequence = Number(archive[0]?.sequence) + 1;
  await expect(
    append(f.active.runtimeToken, f.active.epoch, {
      sandboxId: f.row.id,
      generation: f.active.epoch,
      events: [
        {
          sequence,
          event: {
            id: "retry",
            at: Date.now(),
            kind: "other",
            type: "armada/modelRateLimit",
            promptId: "p",
            data: {
              retryCount: 1,
              delayMs: 1000,
              totalWaitMs: 1000,
              message: "Rate limited by the model provider, retrying in 1 s",
            },
          },
        },
      ],
    }),
  ).resolves.toEqual({ acknowledgedSequence: sequence });
  expect(await readHealth()).toEqual(before);
  expect(
    (await f.db.query("select credential_id,credential_version from sandboxes where id=$1", [f.row.id])).rows,
  ).toEqual([{ credential_id: f.account.id, credential_version: f.account.version }]);
});
