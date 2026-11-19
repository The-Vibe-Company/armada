import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { runtimeFixture } from "./runtime.fixture.ts";
import { ENCRYPTION_KEY } from "./support.ts";

let prepared: Promise<Awaited<ReturnType<typeof runtimeFixture>>> | undefined;
beforeAll(async () => {
  prepared = runtimeFixture(undefined, "boat", "codex", true);
  await prepared;
});
afterAll(async () => {
  const pending = prepared;
  prepared = undefined;
  await pending?.then(
    (fixture) => fixture.close(),
    () => undefined,
  );
});

async function nextSequence(f: Awaited<ReturnType<typeof runtimeFixture>>) {
  const { rows: archive } = await f.db.query<{ sequence: string }>(
    "select coalesce(max(sequence),0)::text as sequence from runtime_events where sandbox_id=$1",
    [f.row.id],
  );
  return Number(archive[0]?.sequence) + 1;
}

test("runtime ACK persists provider exhaustion for the pinned revision and ignores a late older fact", async () => {
  const f = await prepared;
  if (!f) throw Error("Runtime account fixture is not open");
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
  await expect(send(2, 100, { code: "usage_limit_exceeded" })).resolves.toEqual({ acknowledgedSequence: 2 });
  expect((await f.db.query("select account_id,account_version,code,resets_at from account_exhaustion")).rows).toEqual([
    {
      account_id: f.account.id,
      account_version: f.account.version,
      code: "usage_limit_exceeded",
      resets_at: new Date(resetsAt),
    },
  ]);
});

test("a mid-turn provider retry leaves the account binding and health intact", async () => {
  const f = await prepared;
  if (!f) throw Error("Runtime account fixture is not open");
  const { append } = createRuntimeEvents(f.authority, ENCRYPTION_KEY);
  const readHealth = async () => (await f.db.query("select * from account_exhaustion")).rows;
  const before = await readHealth();
  const sequence = await nextSequence(f);
  const at = Date.now();
  await expect(
    append(f.active.runtimeToken, f.active.epoch, {
      sandboxId: f.row.id,
      generation: f.active.epoch,
      events: [
        {
          sequence,
          event: {
            id: "retry",
            at,
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
        {
          sequence: sequence + 1,
          event: {
            id: "stopped-retry",
            at: at + 1,
            kind: "other",
            type: "usage_limit",
            promptId: "p",
            data: { code: "rate_limited" },
          },
        },
      ],
    }),
  ).resolves.toEqual({ acknowledgedSequence: sequence + 1 });
  expect(await readHealth()).toEqual(before);
  expect(
    (await f.db.query("select credential_id,credential_version from sandboxes where id=$1", [f.row.id])).rows,
  ).toEqual([{ credential_id: f.account.id, credential_version: f.account.version }]);
});

test("a provider reset outside PostgreSQL's ISO calendar still acknowledges the journal", async () => {
  const f = await prepared;
  if (!f) throw Error("Runtime account fixture is not open");
  const { append } = createRuntimeEvents(f.authority, ENCRYPTION_KEY);
  const sequence = await nextSequence(f);
  await expect(
    append(f.active.runtimeToken, f.active.epoch, {
      sandboxId: f.row.id,
      generation: f.active.epoch,
      events: [
        {
          sequence,
          event: {
            id: "year-zero",
            at: 300,
            kind: "other",
            type: "usage_limit",
            promptId: "p",
            data: { code: "usage_limit_exceeded", resetsAt: "0000-01-01T00:00:00.000Z" },
          },
        },
      ],
    }),
  ).resolves.toEqual({ acknowledgedSequence: sequence });
  expect(
    (await f.db.query("select resets_at from account_exhaustion where account_id=$1", [f.account.id])).rows,
  ).toEqual([{ resets_at: null }]);
});

test("failed runtime setup removes its journal directory and keeps the caller's database open", async () => {
  const f = await prepared;
  if (!f) throw Error("Runtime account fixture is not open");
  const root = await mkdtemp(join(tmpdir(), "runtime-setup-failure-"));
  const tempKey = process.platform === "win32" ? "TEMP" : "TMPDIR";
  const previous = process.env[tempKey];
  process.env[tempKey] = root;
  try {
    await expect(
      runtimeFixture(f, "boat", "codex", true, undefined, {
        goldenId: crypto.randomUUID(),
        providerSandboxId: "missing-golden",
      }),
    ).rejects.toThrow("sandbox golden does not exist");
    expect(await readdir(root)).toEqual([]);
    expect(f.db.closed).toBe(false);
  } finally {
    if (previous === undefined) delete process.env[tempKey];
    else process.env[tempKey] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
