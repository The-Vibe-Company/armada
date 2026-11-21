import { afterAll, beforeAll, expect, jest, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { decryptSecret, encryptSecret, type Provider, ProviderError } from "@armada/core/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createAccountTurnQueue } from "../src/account-turn-queue.ts";
import type { Caller } from "../src/caller.ts";
import { createSqlData } from "../src/data.ts";
import { createRuntimeProvider, type RuntimeWorkProvider } from "../src/runtime-provider.ts";
import { deleteSandboxWithActivity } from "../src/sandbox-rest-controls.ts";
import { bindRestTool, type ToolContext } from "../src/tools.ts";
import { preserveBeforeStop, readWorkRecovery } from "../src/work-preservation.ts";
import { closeableFixture } from "./closeable.fixture.ts";
import { encryptedRecoveryExec } from "./fixtures/recovery-exec.ts";
import { migratedDatabase } from "./migrated-database.ts";
import { bunLikeSql, ENCRYPTION_KEY, fakeBoat, seedDatabase } from "./support.ts";

const fixture = closeableFixture(async () => {
  const db = await migratedDatabase();
  try {
    await db.exec("set search_path=public");
    const seeded = await seedDatabase(db);
    const modalGolden = (
      await db.query<{ id: string }>(
        `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,
         modal_workspace,modal_environment,modal_app_id,config)
         values($1,$2,'preservation-modal','private','modal','preservation-modal','preservation-modal',
         'workspace','main','app','{"repos":[],"init":[]}') returning id`,
        [seeded.people.org, seeded.people.owner],
      )
    ).rows[0];
    if (!modalGolden) throw new Error("Missing Modal golden fixture");
    return { ...seeded, modalGoldenId: modalGolden.id, close: () => db.close() };
  } catch (error) {
    await db.close();
    throw error;
  }
});

beforeAll(fixture.setup);
afterAll(fixture.close);
const sharedDatabase = fixture.get;

// Primary owner for encrypted persistence and recovery authorization. Collector behavior
// (including actual Git reconstruction) belongs to core's work-preservation test.
test("recovery receipts retain encrypted versions and only current interior owners/admins can retrieve them", async () => {
  const { db, people, sharedGoldenId: goldenId } = sharedDatabase();
  const oldKey = process.env.ARMADA_ENCRYPTION_KEY;
  process.env.ARMADA_ENCRYPTION_KEY = ENCRYPTION_KEY;
  try {
    const sql = bunLikeSql(db);
    const id = crypto.randomUUID();
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,outputs_failure_reasons)
      values($1,$2,$3,$4,'boat','bx_recovery','claude','running',array['collector_unsupported'])`,
      [id, goldenId, people.org, people.owner],
    );
    const historicalId = crypto.randomUUID();
    const historicalArchive = Buffer.from("older recovery fixture").toString("base64");
    await db.query(
      "insert into sandbox_work_recovery(id,sandbox_id,archive_enc,created_at) values($1,$2,$3,'2020-01-01')",
      [historicalId, id, await encryptSecret(historicalArchive)],
    );
    const data = (userId: string, orgId = people.org) =>
      createSqlData(sql)({ via: "service", userId, orgs: [{ orgId, role: "admin" }] }).sandboxes;
    const owner = data(people.owner);
    const boat = fakeBoat();
    const archive = Buffer.from("recovery fixture: private repository material").toString("base64");
    const provider = {
      ...boat.provider,
      async interrupt() {
        throw new Error("idle harness must not be interrupted");
      },
      async quiesce() {},
      async get() {
        return { id: "bx_recovery", name: "recovery", state: "ready" as const, providerState: "running", labels: {} };
      },
      exec: encryptedRecoveryExec(() => archive, boat.provider.exec),
    };
    const commands = boat.execs.length;
    const pending = {
      ...provider,
      quiesce: async () => {
        throw new ProviderError({
          provider: "boat",
          code: "sandbox_not_ready",
          retryable: true,
          message: "Interruption pending",
        });
      },
    };
    expect(await preserveBeforeStop(sql, pending, id, "bx_recovery")).toBe("pending");
    expect(boat.execs).toHaveLength(commands);
    expect((await owner.get(id))?.preservationNote).toBeNull();
    // A failed capture must retain the old archive and allow a later dirty capture.
    boat.setExecOutput({ stdout: JSON.stringify({ status: "failed", reason: "collector_failed" }) });
    await preserveBeforeStop(sql, provider, id, "bx_recovery");
    expect(await owner.readWorkRecovery?.(id, historicalId)).toBe(historicalArchive);
    expect((await owner.get(id))?.preservationNote).toContain("capture_collector_failed");

    const token = crypto.randomUUID();
    const {
      rows: [stop],
    } = await db.query<{ lifecycle_generation: number }>(
      `update sandboxes set status='stopping', stop_requested_at=now(), stop_generation=1,
       activity_lease_id=$2, activity_until=now()+interval '2 minutes' where id=$1 returning lifecycle_generation`,
      [id, token],
    );
    const authority = { kind: "activity" as const, token, generation: stop!.lifecycle_generation };
    boat.setExecOutput({
      stdout: JSON.stringify({
        status: "preserved",
        bytes: Buffer.from(archive, "base64").length,
        sha256: createHash("sha256").update(Buffer.from(archive, "base64")).digest("hex"),
      }),
    });
    await preserveBeforeStop(sql, provider, id, "bx_recovery", "user_stop", authority);
    await preserveBeforeStop(sql, provider, id, "bx_recovery", "user_stop", authority);
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(2);
    const captured = (
      await db.query<{ id: string; archive_enc: Uint8Array<ArrayBuffer> }>(
        "select id,archive_enc from sandbox_work_recovery where sandbox_id=$1 and id<>$2",
        [id, historicalId],
      )
    ).rows[0];
    if (!captured) throw new Error("Missing recovery artifact");
    expect(Buffer.from(captured.archive_enc).includes(Buffer.from(archive))).toBe(false);
    expect(await decryptSecret(captured.archive_enc)).toBe(archive);
    expect((await owner.get(id))?.preservationNote).toBe(
      `unpushed work preserved at work_recovery:${id}/${captured.id}`,
    );
    expect(await owner.readWorkRecovery?.(id)).toBe(archive);

    await owner.update(id, {
      ownerStop: true,
      status: "stopping",
      stopRequested: true,
      finishActivity: true,
      expectedGeneration: authority.generation,
      activityToken: token,
    });
    const handoff = (
      await db.query<{ current: boolean; lifecycle_generation: number }>(
        `select s.lifecycle_generation, r.generation = s.lifecycle_generation as current
         from sandboxes s left join sandbox_native_preservation_receipts r on r.sandbox_id=s.id where s.id=$1`,
        [id],
      )
    ).rows[0];
    expect(handoff?.current).toBe(true);
    authority.generation = handoff!.lifecycle_generation;

    await db.query("update sandboxes set activity_lease_id=$2, activity_until=now()+interval '2 minutes' where id=$1", [
      id,
      token,
    ]);
    await preserveBeforeStop(sql, provider, id, "bx_recovery", "user_stop", authority);
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(2);

    await db.query("delete from sandbox_work_recovery where id=$1", [captured.id]);
    await preserveBeforeStop(sql, provider, id, "bx_recovery", "user_stop", authority);
    expect(await owner.readWorkRecovery?.(id)).toBe(archive);
    expect(await owner.readWorkRecovery?.(id, captured.id)).toBeNull();

    // A clean retry clears the current banner without losing recovery data.
    await db.query(
      `update sandboxes set stop_generation=2, preservation_note='old failure',
       activity_lease_id=$2, activity_until=now()+interval '2 minutes' where id=$1`,
      [id, token],
    );
    // Clean stops do not create archives; historical archives remain retrievable.
    boat.setExecOutput({ stdout: JSON.stringify({ status: "clean" }) });
    await preserveBeforeStop(sql, provider, id, "bx_recovery", "user_stop", authority);
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(2);
    expect((await owner.get(id))?.preservationNote).toBeNull();

    await owner.update(id, {
      ownerStop: true,
      status: "stopped",
      stoppedAt: new Date(0).toISOString(),
      stopRequested: false,
      finishActivity: true,
      expectedGeneration: authority.generation,
      activityToken: token,
    });
    const receipt = (
      await db.query(
        `select s.status, r.generation = s.lifecycle_generation and r.stop_generation = s.stop_generation as current
         from sandboxes s left join sandbox_native_preservation_receipts r on r.sandbox_id=s.id where s.id=$1`,
        [id],
      )
    ).rows[0];
    expect(receipt).toEqual({ status: "stopped", current: true });

    expect(await owner.readWorkRecovery?.(id)).toBe(archive);
    expect(await owner.readWorkRecovery?.(id, historicalId)).toBe(historicalArchive);
    expect(await data(people.admin).readWorkRecovery?.(id)).toBe(archive);
    // Stale admin claims cannot upgrade an ordinary org member's interior access.
    await expect(data(people.member).readWorkRecovery?.(id, historicalId)).rejects.toThrow("No such sandbox");
    await expect(data(people.member, people.otherOrg).readWorkRecovery?.(id)).rejects.toThrow("No such sandbox");
    const otherId = crypto.randomUUID();
    expect(await owner.readWorkRecovery?.(id, otherId)).toBeNull();

    // Ciphertext is not directly readable with a dashboard user's database role.
    await db.exec("set role authenticated");
    try {
      await expect(db.query("select archive_enc from sandbox_work_recovery")).rejects.toThrow("permission denied");
      await expect(db.query("select generation from sandbox_native_preservation_receipts")).rejects.toThrow(
        "permission denied",
      );
    } finally {
      await db.exec("reset role");
    }
  } finally {
    if (oldKey === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
    else process.env.ARMADA_ENCRYPTION_KEY = oldKey;
  }
});

// Distinct lifecycle contract: a timed-out observation must never admit later
// interrupt/exec work after the caller is free to stop the machine.
test.each(["observe", "quiesce", "capture", "known_capture"])(
  "the stop deadline fences late %s work",
  async (stage) => {
    const { db, people, sharedGoldenId: goldenId } = sharedDatabase();
    const originalTimeout = globalThis.setTimeout;
    try {
      const sql = bunLikeSql(db);
      const id = crypto.randomUUID();
      const physical = `bx_late_recovery_${id}`;
      await db.query(
        `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
      values($1,$2,$3,$4,'boat',$5,'claude','running')`,
        [id, goldenId, people.org, people.owner, physical],
      );
      const boat = fakeBoat();
      const info = {
        id: physical,
        name: "late",
        state: "ready" as const,
        providerState: "running",
        labels: {},
      };
      let release: (() => void) | undefined;
      let reached: (() => void) | undefined;
      const boundary = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let expire: (() => void) | undefined;
      let interrupts = 0;
      let execs = 0;
      let captureSignal: AbortSignal | undefined;
      const provider = {
        ...boat.provider,
        get: () =>
          stage === "observe"
            ? new Promise<Awaited<ReturnType<typeof boat.provider.get>>>((resolve) => {
                release = () => resolve(info);
                reached?.();
              })
            : Promise.resolve(info),
        quiesce: () => {
          interrupts++;
          return stage === "capture" || stage === "known_capture"
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                release = resolve;
                reached?.();
              });
        },
        async interrupt() {
          interrupts++;
        },
        async exec(request: Parameters<typeof boat.provider.exec>[0]) {
          execs++;
          captureSignal = request.signal;
          const result = {
            detached: false as const,
            exitCode: 0,
            stdout: '{"status":"clean"}',
            stderr: "",
            timedOut: false,
            truncated: false,
          };
          if (stage === "known_capture" && execs === 1)
            return {
              ...result,
              stdout: JSON.stringify({
                status: "preserved",
                bytes: 32,
                sha256: "0".repeat(64),
                key: Buffer.alloc(256).toString("base64"),
              }),
            };
          return new Promise<typeof result>((resolve) => {
            release = () => resolve(result);
            reached?.();
          });
        },
      };
      globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        if (ms === 20_000) {
          expire = () => callback(...args);
          return originalTimeout(() => {}, 100_000);
        }
        return originalTimeout(callback, ms, ...args);
      }) as typeof setTimeout;
      const stopped = preserveBeforeStop(sql, provider, id, physical);
      await boundary;
      if (!expire || !release) throw new Error("Expected pending provider observation and deadline");
      expire();
      expect(await stopped).toBe(stage === "capture" || stage === "known_capture" ? undefined : "pending");
      if (stage === "capture" || stage === "known_capture") expect(captureSignal?.aborted).toBe(true);
      release();
      await Promise.resolve();
      await Promise.resolve();
      const row = (
        await db.query<{ preservation_note: string }>("select preservation_note from sandboxes where id=$1", [id])
      ).rows[0];
      if (stage === "known_capture") expect(row?.preservation_note).toContain("(capture_timeout)");
      else if (stage === "capture")
        expect(row?.preservation_note).toBe(
          "could not check for unpushed work (capture_timeout). If this sandbox had local work, resume it and push or copy it before stopping again.",
        );
      else expect(row?.preservation_note ?? null).toBeNull();
      expect(interrupts).toBe(stage === "observe" ? 0 : 1);
      expect(execs).toBe(stage === "known_capture" ? 2 : stage === "capture" ? 1 : 0);
      expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(0);
    } finally {
      globalThis.setTimeout = originalTimeout;
    }
  },
);

async function withPreservationRow(
  work: (fixture: {
    db: Awaited<ReturnType<typeof sharedDatabase>>["db"];
    sql: ReturnType<typeof bunLikeSql>;
    id: string;
    physical: string;
    generation: number;
    activity: string | null;
    boat: ReturnType<typeof fakeBoat>;
    provider: ReturnType<typeof fakeBoat>["provider"];
  }) => Promise<void>,
  machine: "boat" | "modal" = "boat",
) {
  const { db, people, sharedGoldenId: goldenId, modalGoldenId } = sharedDatabase();
  const id = crypto.randomUUID();
  const modal = machine === "modal";
  const physical = modal ? `modal_machine_${id}` : `bx_policy_${id}`;
  const activity = modal ? crypto.randomUUID() : null;
  const inserted = await db.query<{ lifecycle_generation: number }>(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,
       runtime_transport,outputs_failure_reasons,stop_requested_at,stop_generation,activity_lease_id,activity_until)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,array['collector_unsupported'],
       case when $10::uuid is not null then now() end,
       case when $10::uuid is not null then 1 else 0 end,
       $10,case when $10::uuid is not null then now()+interval '2 minutes' end)
    returning lifecycle_generation`,
    [
      id,
      modal ? modalGoldenId : goldenId,
      people.org,
      people.owner,
      machine,
      physical,
      modal ? "codex" : "claude",
      modal ? "stopping" : "running",
      modal ? "dialout" : null,
      activity,
    ],
  );
  const boat = fakeBoat();
  const provider = {
    ...boat.provider,
    get: async () => ({
      id: physical,
      name: "policy",
      state: "ready" as const,
      providerState: "idle",
      labels: {},
    }),
    quiesce: async () => {},
  };
  await work({
    db,
    id,
    physical,
    generation: inserted.rows[0]!.lifecycle_generation,
    activity,
    boat,
    provider,
    sql: bunLikeSql(db),
  });
}

test("confirmed work at risk records a closed stage/reason and owner action", async () => {
  await withPreservationRow(async ({ db, id, physical, sql, boat, provider }) => {
    boat.setExecOutput({ stdout: JSON.stringify({ status: "failed", reason: "size_limit", workAtRisk: true }) });
    await preserveBeforeStop(sql, provider, id, physical);
    expect(
      (await db.query<{ preservation_note: string }>("select preservation_note from sandboxes where id=$1", [id]))
        .rows[0]?.preservation_note,
    ).toBe(
      "unpushed work could not be preserved (capture_size_limit). Resume the sandbox and push or copy any local work before stopping again.",
    );
  });
});

test.each(["get", "quiesce", "exec"] as const)(
  "unknown work after %s failure keeps an informational owner notice",
  async (method) => {
    await withPreservationRow(async ({ db, id, physical, sql, provider }) => {
      const log = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await preserveBeforeStop(
          sql,
          {
            ...provider,
            [method]: async () => {
              throw new ProviderError({
                provider: "boat",
                code: "unavailable",
                status: 502,
                retryable: true,
                message: "PRIVATE_MESSAGE",
                details: { secret: "PRIVATE_BODY" },
              });
            },
          },
          id,
          physical,
        );
        expect(
          (
            await db.query<{ preservation_note: string | null }>(
              "select preservation_note from sandboxes where id=$1",
              [id],
            )
          ).rows[0]?.preservation_note,
        ).toContain("could not check for unpushed work (");
        const line = String(log.mock.calls.at(-1)?.[0]);
        expect(JSON.parse(line)).toMatchObject({
          event: "work_preservation_failed",
          workRisk: "unknown",
          providerStatus: 502,
        });
        expect(line).not.toContain("PRIVATE");
      } finally {
        log.mockRestore();
      }
    });
  },
);

test("refused collector exec preserves conditional guidance when risk cannot be checked", async () => {
  await withPreservationRow(async ({ db, id, physical, sql, provider }) => {
    await preserveBeforeStop(
      sql,
      {
        ...provider,
        exec: async () => {
          throw new ProviderError({
            provider: "boat",
            code: "sandbox_not_ready",
            retryable: false,
            message: "PRIVATE_PROVIDER_TEXT",
          });
        },
      },
      id,
      physical,
    );
    const row = (
      await db.query<{ preservation_note: string | null }>("select preservation_note from sandboxes where id=$1", [id])
    ).rows[0];
    expect(row?.preservation_note).toBe(
      "could not check for unpushed work (collect_exec_not_ready). If this sandbox had local work, resume it and push or copy it before stopping again.",
    );
  });
});

test("a successful clean check stays silent if clearing the receipt must be retried", async () => {
  await withPreservationRow(async ({ db, id, physical, boat, provider }) => {
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    let failed = false;
    const sql = bunLikeSql(db, (text) => {
      if (!failed && /^\s*update/i.test(text)) {
        failed = true;
        throw new Error("Synthetic cleanup failure");
      }
    });
    await preserveBeforeStop(sql, provider, id, physical);
    expect(
      (
        await db.query<{ preservation_note: string | null }>("select preservation_note from sandboxes where id=$1", [
          id,
        ])
      ).rows[0]?.preservation_note,
    ).toBeNull();
  });
});

test("a late failed pass cannot overwrite a concurrent successful stop receipt", async () => {
  await withPreservationRow(async ({ db, id, physical, sql, boat, provider, generation }) => {
    const token = crypto.randomUUID();
    await db.query("update sandboxes set activity_lease_id=$2, activity_until=now()+interval '2 minutes' where id=$1", [
      id,
      token,
    ]);
    const authority = { kind: "activity", token, generation } as const;
    await db.query("update sandboxes set stop_requested_at='2026-11-11T08:00:00Z',stop_generation=1 where id=$1", [id]);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const late = {
      ...provider,
      exec: () =>
        new Promise<Awaited<ReturnType<typeof provider.exec>>>((_, reject) => {
          release = () =>
            reject(
              new ProviderError({
                provider: "boat",
                code: "sandbox_not_ready",
                retryable: false,
                message: "Archiving",
              }),
            );
          entered?.();
        }),
    };
    const failed = preserveBeforeStop(sql, late, id, physical, "user_stop", authority);
    await ready;
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    await preserveBeforeStop(sql, provider, id, physical, "user_stop", authority);
    release?.();
    await failed;
    expect(
      (
        await db.query<{ preservation_note: string | null }>("select preservation_note from sandboxes where id=$1", [
          id,
        ])
      ).rows[0],
    ).toMatchObject({ preservation_note: null });
  });
});

test("native stop recaptures an unbound or superseded receipt before reusing current evidence", async () => {
  await withPreservationRow(async ({ db, id, physical, sql, boat, provider, generation }) => {
    const token = crypto.randomUUID();
    await db.query(
      `update sandboxes set status='stopping', stop_requested_at=now(), stop_generation=1,
       preservation_stop_generation=1, activity_lease_id=$2, activity_until=now()+interval '2 minutes' where id=$1`,
      [id, token],
    );
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    const capture = (currentGeneration: number) =>
      preserveBeforeStop(sql, provider, id, physical, "user_stop", {
        kind: "activity",
        token,
        generation: currentGeneration,
      });
    expect(await capture(generation)).toBeUndefined();
    expect(boat.execs).toHaveLength(1);
    expect(await capture(generation)).toBeUndefined();
    expect(boat.execs).toHaveLength(1);

    await db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [id]);
    expect(await capture(Number(generation) + 1)).toBeUndefined();
    expect(boat.execs).toHaveLength(2);

    await db.query("update sandboxes set stop_generation=2, preservation_stop_generation=2 where id=$1", [id]);
    expect(await capture(Number(generation) + 1)).toBeUndefined();
    expect(boat.execs).toHaveLength(3);
  });
});

test("a user JWT cannot forge stop receipts or write application-secret taint", async () => {
  await withPreservationRow(async ({ db }) => {
    await db.exec("set role authenticated");
    try {
      await expect(db.query("insert into sandboxes(preservation_stop_generation) values(1)")).rejects.toThrow(
        "permission denied",
      );
      await expect(db.query("update sandboxes set application_secret_tainted=true")).rejects.toThrow(
        "permission denied",
      );
    } finally {
      await db.exec("reset role");
    }
  });
});

test("an unavailable receipt lookup defers stop without provider work", async () => {
  const sql = {
    query: async () => {
      throw new Error("Synthetic receipt outage");
    },
  };
  const boat = fakeBoat();
  let reads = 0;
  const provider = {
    ...boat.provider,
    async get() {
      reads++;
      throw new Error("Must defer before observing the machine");
    },
  };
  expect(await preserveBeforeStop(sql, provider, crypto.randomUUID(), "bx_policy")).toBe("pending");
  expect(reads).toBe(0);
});

// The real persistence boundary owns this no-archive contract, including restart.
test("application-secret taint permanently disables collection and recovery, purging older archives", async () => {
  const { db, people, sharedGoldenId: goldenId } = sharedDatabase();

  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
       values($1,$2,$3,$4,'boat','bx_tainted','claude','running')`,
    [id, goldenId, people.org, people.owner],
  );
  await db.query("insert into sandbox_work_recovery(sandbox_id,archive_enc) values($1,$2)", [id, new Uint8Array([1])]);
  // Taint after a completed stop must replace the now-purged recovery pointer,
  // even when the completed stop receipt prevents normal note updates.
  await db.query(
    "update sandboxes set stop_requested_at=now(),preservation_stop_generation=stop_generation,preservation_note='unpushed work preserved' where id=$1",
    [id],
  );
  await db.query("update sandboxes set application_secret_tainted=true where id=$1", [id]);
  expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(0);
  await expect(db.query("update sandboxes set application_secret_tainted=false where id=$1", [id])).rejects.toThrow(
    "irreversible",
  );
  await expect(
    db.query("insert into sandbox_work_recovery(sandbox_id,archive_enc) values($1,$2)", [id, new Uint8Array([1])]),
  ).rejects.toThrow("Work recovery unavailable");
  const taintNote = (
    await db.query<{ preservation_note: string }>("select preservation_note from sandboxes where id=$1", [id])
  ).rows[0]!.preservation_note;
  expect(taintNote).toContain("resume and recovery are unavailable");
  // Permit the collector's note write, rather than only exercising a completed
  // receipt whose fence suppresses it. Both writers must give identical guidance.
  await db.query("update sandboxes set stop_requested_at=null,preservation_stop_generation=null where id=$1", [id]);
  const boat = fakeBoat();
  let providerReads = 0;
  const provider = {
    ...boat.provider,
    async get() {
      providerReads++;
      throw Error("must not touch tainted compute");
    },
  };
  for (const source of ["user_stop", "lifecycle_stop", "managed_child_stop"] as const) {
    await preserveBeforeStop(bunLikeSql(db), provider, id, "bx_tainted", source);
    const data = createSqlData(bunLikeSql(db))({
      via: "service",
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
    });
    expect(await data.sandboxes.readWorkRecovery?.(id)).toBeNull();
    expect((await data.sandboxes.get(id))?.preservationNote).toBe(taintNote);
  }
  expect(providerReads).toBe(0);
  expect(boat.execs).toHaveLength(0);
});

test.each([
  "dirty",
  "clean",
  "takeover_before_capture",
  "takeover_during_capture",
  "takeover_on_failure",
  "quiescence_rejected",
  "lost_receipt_response",
] as const)("Modal runtime stop preserves work independently of journal retention: %s", async (scenario) => {
  await withPreservationRow(async ({ db, id, physical, sql, provider, activity, generation }) => {
    if (!activity) throw new Error("Missing Modal activity lease fixture");
    const { people } = sharedDatabase();
    const recoveryScope: [string[], string] = [[people.org], people.owner];
    const reconcile = crypto.randomUUID();
    const archive = Buffer.from("dirty Modal workspace fixture").toString("base64");
    const takeOver = () =>
      db.query(
        `update sandboxes set activity_lease_id=null,activity_until=null,reconcile_lease=$2,
           reconcile_lease_until=now()+interval '2 minutes' where id=$1`,
        [id, reconcile],
      );
    let observed = 0;
    let captures = 0;
    const host: RuntimeWorkProvider = {
      ...provider,
      id: "modal",
      async get() {
        observed++;
        if (observed === 1 && scenario === "takeover_before_capture") await takeOver();
        return {
          id: physical,
          name: physical,
          state: "ready",
          providerState: "active",
          labels: {},
          physicalGeneration: "7",
        };
      },
      async captureRuntimeWork(request) {
        expect(request.sandboxId).toBe(physical);
        expect(request.physicalGeneration).toBe("7");
        expect(request.signal.aborted).toBe(false);
        captures++;
        if (captures === 1) {
          if (scenario === "takeover_during_capture" || scenario === "takeover_on_failure") {
            await takeOver();
            if (scenario === "takeover_on_failure") return { status: "failed", reason: "collector_failed" };
          }
          if (scenario === "quiescence_rejected") throw Error("unverified process quiescence");
        }
        return scenario === "clean" ? { status: "clean" } : { status: "preserved", archive };
      },
    };
    const runtime = createRuntimeProvider(host, physical, host, undefined, host.captureRuntimeWork);
    const oldKey = process.env.ARMADA_ENCRYPTION_KEY;
    process.env.ARMADA_ENCRYPTION_KEY = ENCRYPTION_KEY;
    try {
      let lost = false;
      const stopSql: typeof sql = {
        ...sql,
        async query<T>(query: string, params?: unknown[]) {
          const result = await sql.query<T>(query, params);
          if (
            !lost &&
            scenario === "lost_receipt_response" &&
            query.includes("insert into public.sandbox_work_recovery")
          ) {
            lost = true;
            throw Error("connection lost after publication");
          }
          return result;
        },
      };
      const outcome = await preserveBeforeStop(stopSql, runtime, id, physical, "user_stop", {
        kind: "activity",
        token: activity,
        generation,
      });
      const takeover = scenario.startsWith("takeover_");
      const rejected = scenario === "quiescence_rejected";
      expect(outcome).toBe(takeover || rejected || scenario === "lost_receipt_response" ? "pending" : undefined);
      if (takeover) {
        expect(await readWorkRecovery(sql, recoveryScope, id)).toBeNull();
        expect(captures).toBe(scenario === "takeover_before_capture" ? 0 : 1);
      } else {
        expect(captures).toBe(1);
        await takeOver();
      }
      const nextOwner = { kind: "reconcile", token: reconcile, generation } as const;
      expect(await preserveBeforeStop(sql, runtime, id, physical, "lifecycle_stop", nextOwner)).toBeUndefined();
      expect(await readWorkRecovery(sql, recoveryScope, id)).toBe(scenario === "clean" ? null : archive);
      expect(captures).toBe((takeover && scenario !== "takeover_before_capture") || rejected ? 2 : 1);
      const receipt = (
        await db.query<{ preservation_note: string | null; complete: boolean; archives: number }>(
          `select preservation_note,preservation_stop_generation=stop_generation as complete,
             (select count(*)::int from sandbox_work_recovery where sandbox_id=$1) as archives
             from sandboxes where id=$1`,
          [id],
        )
      ).rows[0]!;
      expect(receipt.complete).toBe(true);
      expect(receipt.archives).toBe(scenario === "clean" ? 0 : 1);
      if (scenario === "clean") expect(receipt.preservation_note).toBeNull();
      else expect(receipt.preservation_note).toStartWith(`unpushed work preserved at work_recovery:${id}/`);
    } finally {
      if (oldKey === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
      else process.env.ARMADA_ENCRYPTION_KEY = oldKey;
    }
  }, "modal");
});

test.each(["observe", "capture"] as const)(
  "native stop ownership transfer during %s leaves no stale receipt",
  async (phase) => {
    await withPreservationRow(async ({ db, id, physical, sql, boat, provider, generation }) => {
      const activity = crypto.randomUUID();
      const reconcile = crypto.randomUUID();
      await db.query(
        `update sandboxes set status='stopping', stop_requested_at=now(), stop_generation=1,
         activity_lease_id=$2, activity_until=now()+interval '2 minutes' where id=$1`,
        [id, activity],
      );
      const takeOver = () =>
        db.query(
          `update sandboxes set activity_lease_id=null, activity_until=null,
           reconcile_lease=$2, reconcile_lease_until=now()+interval '2 minutes' where id=$1`,
          [id, reconcile],
        );
      boat.setExecOutput({ stdout: '{"status":"clean"}' });
      let captures = 0;
      let observations = 0;
      const host: typeof provider = {
        ...provider,
        async get() {
          observations++;
          if (phase === "observe" && observations === 1) await takeOver();
          return provider.get(physical);
        },
        async exec(request) {
          captures++;
          if (phase === "capture" && captures === 1) await takeOver();
          return provider.exec(request);
        },
      };
      const readReceipt = async () =>
        (
          await db.query<{ preservation_stop_generation: number | null }>(
            "select preservation_stop_generation from sandboxes where id=$1",
            [id],
          )
        ).rows[0]?.preservation_stop_generation;
      expect(
        await preserveBeforeStop(sql, host, id, physical, "user_stop", {
          kind: "activity",
          token: activity,
          generation,
        }),
      ).toBe("pending");
      expect(await readReceipt()).toBeNull();
      const priorCaptures = phase === "observe" ? 0 : 1;
      expect(captures).toBe(priorCaptures);
      expect(
        await preserveBeforeStop(sql, host, id, physical, "lifecycle_stop", {
          kind: "reconcile",
          token: reconcile,
          generation,
        }),
      ).toBeUndefined();
      expect(Number(await readReceipt())).toBe(1);
      expect(captures).toBe(priorCaptures + 1);
    });
  },
);

async function seedNativeDrainReceipt(ciphertext = new Uint8Array([21, 34, 55]), provider: "boat" | "modal" = "boat") {
  const { db, people, sharedGoldenId, modalGoldenId } = sharedDatabase();
  const sandboxId = crypto.randomUUID();
  const archiveId = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,
       stopped_at,lifecycle_generation,stop_generation,preservation_stop_generation)
     values($1,$2,$3,$4,$5,$6,'claude','stopped',now(),4,2,2)`,
    [
      sandboxId,
      provider === "modal" ? modalGoldenId : sharedGoldenId,
      people.org,
      people.owner,
      provider,
      `bx_${sandboxId}`,
    ],
  );
  await db.query("insert into sandbox_work_recovery(id,sandbox_id,archive_enc) values($1,$2,$3)", [
    archiveId,
    sandboxId,
    ciphertext,
  ]);
  await db.query(
    `insert into sandbox_native_preservation_receipts
       (sandbox_id,generation,stop_generation,capture_generation,capture_stop_generation,archive_id)
     values($1,4,2,4,2,$2)`,
    [sandboxId, archiveId],
  );
  async function copy(generation = 4) {
    const result = await db.query<{ outcome: string }>("select copy_native_drain_recovery($1,$2) as outcome", [
      sandboxId,
      generation,
    ]);
    return result.rows[0]?.outcome;
  }
  return { db, people, sandboxId, archiveId, ciphertext, copy };
}

async function nativeToolFixture(provider: Provider, placement: string, onQuery?: (statement: string) => void) {
  const { db, people, sharedGoldenId, modalGoldenId, openaiCredentialId } = sharedDatabase();
  const sandboxId = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,credential_id,credential_version)
     values($1,$2,$3,$4,$5,$6,'codex','ready',$7,1)`,
    [
      sandboxId,
      provider.id === "modal" ? modalGoldenId : sharedGoldenId,
      people.org,
      people.owner,
      provider.id,
      placement,
      openaiCredentialId,
    ],
  );
  const caller: Caller = { via: "service", userId: people.owner, orgs: [{ orgId: people.org, role: "admin" }] };
  const context: ToolContext = {
    caller,
    data: createSqlData(bunLikeSql(db, onQuery))(caller),
    launchCredentials: {
      async resolve() {
        throw new Error("Existing sandbox tools do not launch a sandbox.");
      },
    },
    exposedSecrets: async () => [],
    provider: async () => provider,
    now: () => new Date(),
    sleep: async () => {
      throw new Error("Unexpected wait");
    },
  };
  function invoke(name: string, input: Record<string, unknown>) {
    let reply: Promise<CallToolResult> | undefined;
    bindRestTool(context, name, (_, _contract, run) => {
      reply = run(input as never);
    });
    if (!reply) throw new Error(`Missing tool: ${name}`);
    return reply;
  }

  return { db, context, sandboxId, invoke };
}

test.each(["boat", "modal"])("ordinary native exec excludes owner stop on %s", async (providerId) => {
  const boat = fakeBoat();
  const machine = await boat.provider.fork({
    from: "fixture-snapshot",
    noEnv: true,
    env: {},
    labels: {},
    ttlSeconds: 3600,
  });
  let stopDuringExec: CallToolResult | undefined;
  const provider = {
    ...boat.provider,
    id: providerId,
    async exec(request: Parameters<typeof boat.provider.exec>[0]) {
      if (request.command === "edit workspace") stopDuringExec = await invoke("stop", { id: sandboxId });
      return boat.provider.exec(request);
    },
  };
  const { invoke, context, sandboxId } = await nativeToolFixture(provider, machine.id);

  const result = await invoke("exec", { id: sandboxId, command: "edit workspace" });
  expect(stopDuringExec?.isError).toBe(true);
  expect(boat.stops).toHaveLength(0);
  expect(result.structuredContent).toMatchObject({ exitCode: 0 });
  const preflightBeforeStop = await context.data.sandboxes.controlState?.(sandboxId);
  boat.setExecOutput({ stdout: '{"status":"clean"}' });
  const stopped = await invoke("stop", { id: sandboxId });
  expect(stopped.structuredContent).toMatchObject({ status: "stopped" });
  expect(boat.stops).toEqual([machine.id]);

  expect(preflightBeforeStop?.status).toBe("ready");
  context.data.sandboxes.controlState = async () => preflightBeforeStop ?? null;
  const commands = boat.execs.length;
  expect((await invoke("exec", { id: sandboxId, command: "must not restore" })).isError).toBe(true);
  expect(boat.execs).toHaveLength(commands);
});

test("ordinary native exec refuses newly tainted Modal workspaces before provider preparation", async () => {
  const fake = fakeBoat();
  const provider = { ...fake.provider, id: "modal" };
  const { db, context, sandboxId, invoke } = await nativeToolFixture(provider, crypto.randomUUID());
  const prepare = mock(async () => {});
  context.connections = {
    async validate() {},
    async bind() {},
    prepare,
  };
  const exec = spyOn(provider, "exec");
  const assertExecAllowed = context.data.sandboxes.assertExecAllowed;
  context.data.sandboxes.assertExecAllowed = async (id) => {
    await assertExecAllowed?.(id);
    await db.query("update sandboxes set application_secret_tainted=true where id=$1", [sandboxId]);
  };

  expect((await invoke("exec", { id: sandboxId, command: "edit workspace" })).isError).toBe(true);
  expect(prepare).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
});

async function handoffWithLaterCleanCapture(sandboxId: string) {
  const { db } = sharedDatabase();
  await db.query(
    `update sandboxes set status='stopped',stopped_at=now(),activity_lease_id=null,activity_until=null,
         lifecycle_generation=lifecycle_generation+1,stop_generation=1,preservation_stop_generation=1
       where id=$1`,
    [sandboxId],
  );
  await db.query(
    `insert into sandbox_native_preservation_receipts
         (sandbox_id,generation,stop_generation,capture_generation,capture_stop_generation,capture_acknowledgements)
       select id,lifecycle_generation,1,lifecycle_generation,1,
         jsonb_build_object('completedPrompts',(
           select jsonb_agg(p.prompt_id) from native_webhook_prompts p
           where p.sandbox_id=sandboxes.id and p.completed_at is not null
         ))
       from sandboxes where id=$1`,
    [sandboxId],
  );
  return db.query("select copy_native_drain_recovery(id,lifecycle_generation) as outcome from sandboxes where id=$1", [
    sandboxId,
  ]);
}

test.each([
  "lost reply",
  "unverified history fallback",
  "verified replacement",
  "failed admission",
  "failed publication",
  "expired activity",
])("native steer handoff checks dispatch evidence after %s", async (outcome) => {
  const boat = fakeBoat();
  const machine = await boat.provider.fork({
    from: "fixture-snapshot",
    noEnv: true,
    env: {},
    labels: {},
    ttlSeconds: 3600,
  });
  const provider = {
    ...boat.provider,
    getPrompt: (request: Parameters<Provider["getPrompt"]>[0]) =>
      boat.provider.getPrompt({ ...request, sandboxId: machine.id }),
    events: (request: Parameters<Provider["events"]>[0]) => boat.provider.events({ ...request, sandboxId: machine.id }),
    steer: mock(async () => {
      const replacement = await boat.provider.prompt({
        sandboxId: machine.id,
        harness: "codex",
        text: "edit workspace",
      });
      if (outcome === "lost reply" && boat.prompts.length === 1) throw new Error("Lost steer response");
      if (outcome === "expired activity")
        await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [sandboxId]);
      return {
        ...replacement,
        promptId: outcome === "unverified history fallback" ? "unverified-steer-id" : replacement.promptId,
      };
    }),
  };
  let settling = false;
  const { db, sandboxId, invoke } = await nativeToolFixture(provider, crypto.randomUUID(), (statement) => {
    if (statement.includes("delete from public.sandbox_native_send_attempts")) settling = true;
    if (
      (outcome === "failed admission" && statement.includes("insert into public.sandbox_native_send_attempts")) ||
      (outcome === "failed publication" &&
        settling &&
        statement.includes("task_prompt_id") &&
        statement.includes("update public.sandboxes"))
    )
      throw new Error(outcome);
  });
  await db.query("update sandboxes set credential_id=null,status='running',task_prompt_id='previous' where id=$1", [
    sandboxId,
  ]);

  const reply = await invoke("steer", { id: sandboxId, text: "edit workspace" });
  expect(provider.steer).toHaveBeenCalledTimes(outcome === "failed admission" ? 0 : 1);
  if (outcome === "unverified history fallback" || outcome === "verified replacement") {
    expect(reply.isError).not.toBe(true);
    const published = await db.query("select task_prompt_id from sandboxes where id=$1", [sandboxId]);
    expect(published.rows).toEqual([{ task_prompt_id: "prompt_1" }]);
  } else {
    expect(reply.isError).toBe(true);
  }
  if (outcome === "failed admission") {
    const row = await db.query(
      "select lifecycle_generation,activity_lease_id,task_prompt_id from sandboxes where id=$1",
      [sandboxId],
    );
    expect(row.rows).toEqual([{ lifecycle_generation: 1, activity_lease_id: null, task_prompt_id: "previous" }]);
  }
  if (outcome === "lost reply") {
    await db.query(
      "update sandboxes set activity_until=now()-interval '1 second',task_prompt_id='prompt_1' where id=$1",
      [sandboxId],
    );
    const later = await invoke("steer", { id: sandboxId, text: "inspect workspace" });
    expect(later.structuredContent).toMatchObject({ promptId: "prompt_2" });
    const unresolved = await db.query("select generation from sandbox_native_send_attempts where sandbox_id=$1", [
      sandboxId,
    ]);
    expect(unresolved.rows).toEqual([{ generation: 2 }]);
  }
  await db.query("update native_webhook_prompts set completed_at=now() where sandbox_id=$1", [sandboxId]);
  const handoff = await handoffWithLaterCleanCapture(sandboxId);
  const eligible = outcome === "verified replacement" || outcome === "failed admission";
  expect(handoff.rows).toEqual([{ outcome: eligible ? "clean" : "ineligible" }]);
});

test.each([
  "lost provider response",
  "acknowledged prompt",
  "admission write failure",
  "settlement write failure",
  "expired activity",
  "stale prompt receipt",
])("native send handoff distinguishes unresolved work after %s", async (outcome) => {
  const boat = fakeBoat();
  const machine = await boat.provider.fork({
    from: "fixture-snapshot",
    noEnv: true,
    env: {},
    labels: {},
    ttlSeconds: 3600,
  });
  const placement = crypto.randomUUID();
  let renewalRefused = false;
  const provider = {
    ...boat.provider,
    async get() {
      return { ...(await boat.provider.get(machine.id)), id: placement };
    },
    async prompt(request: Parameters<typeof boat.provider.prompt>[0]) {
      const receipt = await boat.provider.prompt({ ...request, sandboxId: machine.id });
      if (outcome === "lost provider response" && boat.prompts.length === 1) throw new Error("Lost response");
      if (outcome === "expired activity") {
        const lease = await db.query<{ activity_lease_id: string; lifecycle_generation: number }>(
          "update sandboxes set activity_until=now()-interval '1 second' where id=$1 returning activity_lease_id,lifecycle_generation",
          [sandboxId],
        );
        const active = lease.rows[0];
        if (!active) throw new Error("Missing send activity");
        renewalRefused = await context.data.sandboxes
          .update(sandboxId, {
            renewActivity: true,
            activityToken: active.activity_lease_id,
            expectedGeneration: active.lifecycle_generation,
          })
          .then(
            () => false,
            (error: unknown) => error instanceof Error && error.message.includes("lifecycle changed"),
          );
      }
      return receipt;
    },
  };
  let deletingMarker = false;
  const { db, context, sandboxId, invoke } = await nativeToolFixture(provider, placement, (statement) => {
    if (outcome === "admission write failure" && statement.includes("insert into public.sandbox_native_send_attempts"))
      throw new Error(outcome);
    if (outcome === "settlement write failure" && deletingMarker && statement.includes("task_prompt_id"))
      throw new Error(outcome);
    if (statement.includes("delete from public.sandbox_native_send_attempts")) deletingMarker = true;
  });
  await db.query("update sandboxes set credential_id=null where id=$1", [sandboxId]);

  if (outcome === "stale prompt receipt")
    await db.query(
      `insert into native_webhook_prompts(sandbox_id,prompt_id,provider,provider_sandbox_id,owner_id,org_id,created_at)
         select id,'prompt_1',provider,provider_sandbox_id,owner_id,org_id,'2020-01-01' from sandboxes where id=$1`,
      [sandboxId],
    );

  const reply = await invoke("send", { id: sandboxId, prompt: "edit workspace" });
  expect(boat.prompts).toHaveLength(outcome === "admission write failure" ? 0 : 1);
  if (outcome === "acknowledged prompt") {
    expect(reply.structuredContent).toMatchObject({ promptId: "prompt_1" });
  } else {
    expect(reply.isError).toBe(true);
    const row = await db.query("select task_prompt_id from sandboxes where id=$1", [sandboxId]);
    expect(row.rows).toEqual([{ task_prompt_id: null }]);
  }
  if (outcome === "lost provider response") {
    await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [sandboxId]);
    const later = await invoke("send", { id: sandboxId, prompt: "inspect workspace" });
    expect(later.structuredContent).toMatchObject({ promptId: "prompt_2" });
  }
  if (outcome === "expired activity") expect(renewalRefused).toBe(true);
  if (outcome === "admission write failure") {
    const row = await db.query("select lifecycle_generation, activity_lease_id from sandboxes where id=$1", [
      sandboxId,
    ]);
    expect(row.rows).toEqual([{ lifecycle_generation: 1, activity_lease_id: null }]);
  }
  await db.query("update native_webhook_prompts set completed_at=now() where sandbox_id=$1", [sandboxId]);

  const handoff = await handoffWithLaterCleanCapture(sandboxId);
  const safe = outcome === "acknowledged prompt" || outcome === "admission write failure";
  expect(handoff.rows).toEqual([{ outcome: safe ? "clean" : "ineligible" }]);
});

test.each(["lost command response", "failed redaction", "failed evidence insert", "failed evidence delete"])(
  "ordinary native Modal exec preserves the admission and handoff invariants after %s",
  async (failure) => {
    const fake = fakeBoat();
    const provider = { ...fake.provider, id: "modal" };
    const { db, context, sandboxId, invoke } = await nativeToolFixture(provider, crypto.randomUUID(), (statement) => {
      if (failure === "failed evidence insert" && statement.includes("insert into public.sandbox_native_exec_attempts"))
        throw new Error(failure);
      if (failure === "failed evidence delete" && statement.includes("delete from public.sandbox_native_exec_attempts"))
        throw new Error(failure);
    });
    const exec = provider.exec;
    let signal: AbortSignal | undefined;
    provider.exec = async (request) => {
      signal = request.signal;
      if (failure === "lost command response") throw new Error(failure);
      return exec(request);
    };
    if (failure === "failed redaction") {
      context.exposedSecrets = async () => {
        throw new Error(failure);
      };
    }

    const result = await invoke("exec", { id: sandboxId, command: "edit workspace" });
    expect(result.isError).toBe(true);
    const beforeDispatch = failure === "failed evidence insert";
    if (beforeDispatch) expect(signal).toBeUndefined();
    else {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(result.content).toContainEqual({ type: "text", text: "error code: outcome_unknown" });
    }
    const lease = await db.query<{ active: boolean; generation: number }>(
      `select activity_lease_id is not null and activity_until > now() as active,
         lifecycle_generation::integer as generation from sandboxes where id=$1`,
      [sandboxId],
    );
    expect(lease.rows).toEqual([{ active: !beforeDispatch, generation: beforeDispatch ? 1 : 2 }]);
    const handoff = await handoffWithLaterCleanCapture(sandboxId);
    expect(handoff.rows).toEqual([{ outcome: beforeDispatch ? "clean" : "ineligible" }]);
  },
);

test.each(["foreground", "detached", "timed out", "unknown exit", "expired settlement"] as const)(
  "native handoff accounts for a %s exec after the activity window",
  async (outcome) => {
    const fake = fakeBoat();
    const provider: Provider = {
      ...fake.provider,
      async exec(request) {
        if (outcome === "detached" && request.command === "edit workspace") return { detached: true, processId: 42 };
        if (outcome === "expired settlement") {
          await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [sandboxId]);
        }
        const result = await fake.provider.exec(request);
        return result.detached
          ? result
          : { ...result, timedOut: outcome === "timed out", exitCode: outcome === "unknown exit" ? null : 0 };
      },
    };
    const { db, sandboxId, invoke } = await nativeToolFixture(provider, crypto.randomUUID());
    const reply = await invoke("exec", { id: sandboxId, command: "edit workspace" });
    if (outcome === "foreground") expect(reply.structuredContent).toMatchObject({ exitCode: 0 });
    if (outcome === "detached") {
      await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [sandboxId]);
      const next = await invoke("exec", { id: sandboxId, command: "inspect workspace" });
      expect(next.structuredContent).toMatchObject({ exitCode: 0 });
    }

    const observed = await handoffWithLaterCleanCapture(sandboxId);
    expect(observed.rows).toEqual([{ outcome: outcome === "foreground" ? "clean" : "ineligible" }]);
  },
);

test("ordinary native exec skips post-command provider sampling after the activity deadline", async () => {
  const fake = fakeBoat();
  const provider = {
    ...fake.provider,
    id: "modal",
    async exec(request: Parameters<typeof fake.provider.exec>[0]) {
      const completed = await fake.provider.exec(request);
      jest.advanceTimersByTime(180_000);
      return completed;
    },
  };
  const { context, sandboxId, invoke } = await nativeToolFixture(provider, crypto.randomUUID());
  const sampled: (string | undefined)[] = [];
  context.launchCredentials.nativeSecrets = async (_actor, _id, _provider, _placement, phase) => {
    sampled.push(phase);
    return [];
  };

  jest.useFakeTimers();
  try {
    const result = await invoke("exec", { id: sandboxId, command: "edit workspace" });
    expect(result.content).toContainEqual({ type: "text", text: "error code: outcome_unknown" });
    expect(fake.execs).toHaveLength(1);
    expect(sampled).toEqual(["before"]);
  } finally {
    jest.useRealTimers();
  }
});

test.each(["missing proof", "rolled-back admission", "lost commit response", "verified proof"])(
  "native drain deletion commits preservation and admission together with %s",
  async (scenario) => {
    const { db, people, sandboxId, archiveId } = await seedNativeDrainReceipt();
    const caller: Caller = { via: "service", userId: people.owner, orgs: [{ orgId: people.org, role: "member" }] };
    const sql = bunLikeSql(db);
    if (scenario === "lost commit response") {
      const transaction = sql.transaction;
      if (!transaction) throw new Error("Missing transaction support");
      sql.transaction = async (work) => {
        await transaction(work);
        throw new Error("Delete admission commit response lost");
      };
    }
    const { sandboxes } = createSqlData(sql)(caller);
    const provider = fakeBoat().provider;
    const detached = () => db.query("select archive_id from native_drain_recovery where sandbox_id=$1", [sandboxId]);
    const state = async () =>
      (await db.query("select status, lifecycle_generation::int as generation from sandboxes where id=$1", [sandboxId]))
        .rows[0];
    const remove = mock(async () => {
      if (scenario === "verified proof") {
        expect((await detached()).rows).toEqual([{ archive_id: archiveId }]);
        expect(await state()).toEqual({ status: "stopped", generation: 5 });
      }
      return { status: "deleted" as const };
    });
    provider.delete = remove;
    if (scenario === "missing proof")
      await db.query("delete from sandbox_native_preservation_receipts where sandbox_id=$1", [sandboxId]);
    if (scenario === "rolled-back admission") {
      await db.exec(`
        create function refuse_drain_admission() returns trigger language plpgsql as $$
        begin
          if new.activity_lease_id is not null then return null; end if;
          return new;
        end;
        $$;
        create trigger refuse_drain_admission before update on sandboxes
          for each row execute function refuse_drain_admission();
      `);
    }
    try {
      const deletion = deleteSandboxWithActivity(
        sandboxes,
        { resolve: async () => provider },
        sandboxId,
        "native-drain",
      );
      if (scenario === "verified proof") {
        expect(await deletion).toEqual({ id: sandboxId, status: "deleted" });
        expect(remove).toHaveBeenCalledTimes(1);
        expect(await state()).toEqual({ status: "deleted", generation: 6 });
        expect((await detached()).rows).toEqual([{ archive_id: archiveId }]);
      } else if (scenario === "lost commit response") {
        await expect(deletion).rejects.toThrow("Delete admission commit response lost");
        expect(remove).not.toHaveBeenCalled();
        expect(await state()).toEqual({ status: "stopped", generation: 5 });
        expect((await detached()).rows).toEqual([{ archive_id: archiveId }]);
        expect((await db.query("select activity_lease_id from sandboxes where id=$1", [sandboxId])).rows[0]).toEqual({
          activity_lease_id: expect.any(String),
        });
      } else {
        await expect(deletion).rejects.toMatchObject({ code: "sandbox_not_ready" });
        expect(remove).not.toHaveBeenCalled();
        expect(await state()).toEqual({ status: "stopped", generation: 4 });
        expect((await detached()).rows).toEqual([]);
      }
    } finally {
      if (scenario === "rolled-back admission")
        await db.exec("drop trigger refuse_drain_admission on sandboxes; drop function refuse_drain_admission()");
    }
  },
);

test("native drain refuses a scoped Modal parent before committing intent or calling delete", async () => {
  const { db, people, sandboxId } = await seedNativeDrainReceipt(undefined, "modal");
  await db.query(
    `insert into public.armada_access_parents (id, kind, org_id, owner_id, sandbox_id, state)
     values ($1, 'sandbox', $2, $3, $1, 'ready')`,
    [sandboxId, people.org, people.owner],
  );
  const caller: Caller = { via: "service", userId: people.owner, orgs: [{ orgId: people.org, role: "member" }] };
  const { sandboxes } = createSqlData(bunLikeSql(db))(caller);
  const remove = mock(async () => ({ status: "deleted" as const }));
  const provider: Provider = { ...fakeBoat().provider, id: "modal", delete: remove };
  await expect(
    deleteSandboxWithActivity(sandboxes, { resolve: async () => provider }, sandboxId, "native-drain"),
  ).rejects.toMatchObject({ code: "sandbox_not_ready" });
  expect(remove).not.toHaveBeenCalled();
  expect(
    (await db.query("select status, native_drain_pending from public.sandboxes where id=$1", [sandboxId])).rows,
  ).toEqual([{ status: "stopped", native_drain_pending: false }]);
  expect(
    (await db.query("select archive_id from public.native_drain_recovery where sandbox_id=$1", [sandboxId])).rows,
  ).toEqual([]);
});

test.each(["not_found", "pending", "settlement failure"] as const)(
  "native drain keeps its row, archive and lease after %s",
  async (outcome) => {
    const providerId = outcome === "not_found" ? "boat" : "modal";
    const { db, people, sandboxId, archiveId } = await seedNativeDrainReceipt(undefined, providerId);
    const caller: Caller = { via: "service", userId: people.owner, orgs: [{ orgId: people.org, role: "member" }] };
    const sql = bunLikeSql(db);
    const transaction = sql.transaction;
    if (!transaction) throw new Error("Missing transaction support");
    let providerCalled = false;
    if (outcome === "settlement failure") {
      sql.transaction = async (work) => {
        if (providerCalled) throw new Error("Delete settlement unavailable");
        return transaction(work);
      };
    }
    const provider: Provider = {
      ...fakeBoat().provider,
      id: providerId,
      delete: mock(async () => {
        providerCalled = true;
        if (outcome === "not_found")
          throw new ProviderError({
            provider: providerId,
            code: "not_found",
            message: "Delete target unavailable",
            retryable: false,
          });
        return { status: outcome === "pending" ? "pending" : "deleted" };
      }),
    };
    const { sandboxes } = createSqlData(sql)(caller);
    const deletion = deleteSandboxWithActivity(sandboxes, { resolve: async () => provider }, sandboxId, "native-drain");
    await expect(deletion).rejects.toThrow(
      {
        not_found: "Delete target unavailable",
        pending: "Provider deletion is pending",
        "settlement failure": "Delete settlement unavailable",
      }[outcome],
    );
    expect(provider.delete).toHaveBeenCalledWith({ sandboxId: `bx_${sandboxId}`, generation: 5 });
    const state = await db.query(
      `select status, lifecycle_generation::int as generation,
         activity_lease_id is not null and activity_until>now() as leased
       from sandboxes where id=$1`,
      [sandboxId],
    );
    expect(state.rows).toEqual([{ status: "stopped", generation: 5, leased: true }]);
    const archive = await db.query("select archive_id from native_drain_recovery where sandbox_id=$1", [sandboxId]);
    expect(archive.rows).toEqual([{ archive_id: archiveId }]);
  },
);

test.each([
  "lost admission reply",
  "lost provider reply",
  "lost settlement",
  "unavailable provider",
  "Boat pending",
] as const)("native drain replay handles %s without repeating work preservation", async (scenario) => {
  const providerId = scenario === "Boat pending" ? "boat" : "modal";
  const { db, people, sandboxId, archiveId } = await seedNativeDrainReceipt(undefined, providerId);
  const caller: Caller = { via: "service", userId: people.owner, orgs: [{ orgId: people.org, role: "member" }] };
  const sql = bunLikeSql(db);
  const transaction = sql.transaction;
  if (!transaction) throw new Error("Missing transaction support");
  let retry = false;
  let providerCalled = false;
  sql.transaction = async (work) => {
    if (!retry && scenario === "lost settlement" && providerCalled) throw new Error("Settlement unavailable");
    const result = await transaction(work);
    if (!retry && scenario === "lost admission reply") throw new Error("Admission reply lost");
    return result;
  };
  const provider: Provider = {
    ...fakeBoat().provider,
    id: providerId,
    delete: mock(async () => {
      providerCalled = true;
      if (!retry && scenario === "lost provider reply") throw new Error("Provider reply lost");
      if (retry && scenario === "unavailable provider")
        throw new ProviderError({
          provider: providerId,
          code: "not_found",
          message: "App unavailable",
          retryable: true,
        });
      return {
        status: scenario === "Boat pending" || (!retry && scenario === "unavailable provider") ? "pending" : "deleted",
      };
    }),
  };
  const { sandboxes } = createSqlData(sql)(caller);
  const drain = () =>
    deleteSandboxWithActivity(sandboxes, { resolve: async () => provider }, sandboxId, "native-drain");
  await expect(drain()).rejects.toThrow();
  retry = true;
  const callsBeforeRetry = scenario === "lost admission reply" ? 0 : 1;
  await expect(drain()).rejects.toMatchObject({ code: "sandbox_not_ready" });
  expect(provider.delete).toHaveBeenCalledTimes(callsBeforeRetry);
  await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [sandboxId]);
  if (scenario === "Boat pending") {
    await expect(drain()).rejects.toMatchObject({ code: "sandbox_not_ready" });
    expect(provider.delete).toHaveBeenCalledTimes(callsBeforeRetry);
  } else if (scenario === "unavailable provider") {
    await expect(drain()).rejects.toThrow("App unavailable");
  } else {
    await expect(drain()).resolves.toEqual({ id: sandboxId, status: "deleted" });
    await expect(drain()).resolves.toEqual({ id: sandboxId, status: "deleted" });
  }
  if (scenario !== "Boat pending") {
    expect(provider.delete).toHaveBeenCalledTimes(callsBeforeRetry + 1);
    expect(provider.delete).toHaveBeenLastCalledWith({ sandboxId: `bx_${sandboxId}`, generation: 6 });
  }
  const { rows } = await db.query(
    `select s.status,s.native_drain_pending,r.archive_id
       from sandboxes s join native_drain_recovery r on r.sandbox_id=s.id where s.id=$1`,
    [sandboxId],
  );
  const pending = scenario === "Boat pending" || scenario === "unavailable provider";
  expect(rows).toEqual([
    { status: pending ? "stopped" : "deleted", native_drain_pending: pending, archive_id: archiveId },
  ]);
});

test("a late Modal delete receipt cannot settle the retry owner's generation", async () => {
  const { db, people, sandboxId } = await seedNativeDrainReceipt(undefined, "modal");
  const caller: Caller = { via: "service", userId: people.owner, orgs: [{ orgId: people.org, role: "member" }] };
  const { sandboxes } = createSqlData(bunLikeSql(db))(caller);
  const firstDispatched = Promise.withResolvers<void>();
  const retryDispatched = Promise.withResolvers<void>();
  const firstReceipt = Promise.withResolvers<void>();
  const retryReceipt = Promise.withResolvers<void>();
  let dispatches = 0;
  const provider: Provider = {
    ...fakeBoat().provider,
    id: "modal",
    delete: async () => {
      if (++dispatches === 1) {
        firstDispatched.resolve();
        await firstReceipt.promise;
      } else {
        retryDispatched.resolve();
        await retryReceipt.promise;
      }
      return { status: "deleted" };
    },
  };
  const drain = () =>
    deleteSandboxWithActivity(sandboxes, { resolve: async () => provider }, sandboxId, "native-drain");
  const first = drain();
  try {
    await Promise.race([first, firstDispatched.promise]);
    await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [sandboxId]);
    const retry = drain();
    try {
      await Promise.race([retry, retryDispatched.promise]);
      firstReceipt.resolve();
      await expect(first).rejects.toThrow("Sandbox deletion receipt is stale.");
      expect((await db.query("select status from sandboxes where id=$1", [sandboxId])).rows).toEqual([
        { status: "stopped" },
      ]);
    } finally {
      retryReceipt.resolve();
      await expect(retry).resolves.toEqual({ id: sandboxId, status: "deleted" });
    }
  } finally {
    firstReceipt.resolve();
    await first.catch(() => undefined);
  }
});

test.each(["activity", "queue", "provider observation", "owner row update", "ordinary delete"] as const)(
  "uncertain native drain refuses %s after its lease expires",
  async (attempt) => {
    const { db, people, sandboxId } = await seedNativeDrainReceipt();
    const { openaiCredentialId } = sharedDatabase();
    await db.query(
      "update sandboxes set credential_id=$2, credential_version=1, expires_at=now()+interval '1 day' where id=$1",
      [sandboxId, openaiCredentialId],
    );
    const caller: Caller = { via: "service", userId: people.owner, orgs: [{ orgId: people.org, role: "member" }] };
    const sql = bunLikeSql(db);
    const { sandboxes } = createSqlData(sql)(caller);
    const remove = mock(async () => ({ status: "pending" as const }));
    const providers = { resolve: async () => ({ ...fakeBoat().provider, delete: remove }) };
    await expect(deleteSandboxWithActivity(sandboxes, providers, sandboxId, "native-drain")).rejects.toThrow(
      "Provider deletion is pending",
    );
    await db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [sandboxId]);

    if (attempt === "activity") {
      await expect(
        sandboxes.update(sandboxId, {
          advanceGeneration: true,
          expectedGeneration: 5,
          activityToken: crypto.randomUUID(),
          stopRequested: false,
          nativeResumeAdmission: `bx_${sandboxId}`,
        }),
      ).rejects.toMatchObject({ code: "sandbox_not_ready" });
    } else if (attempt === "provider observation") {
      await expect(
        sandboxes.update(sandboxId, {
          status: "ready",
          statusReason: null,
          expectedGeneration: 5,
          providerObservation: { fromState: "stopped", providerRunPlacement: `bx_${sandboxId}` },
        }),
      ).rejects.toMatchObject({ code: "sandbox_not_ready" });
    } else if (attempt === "owner row update") {
      await db.transaction(async (tx) => {
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [people.owner]);
        await tx.exec("set local role authenticated");
        const updated = await tx.query("update sandboxes set status='ready',stopped_at=null where id=$1 returning id", [
          sandboxId,
        ]);
        expect(updated.rows).toEqual([]);
      });
    } else if (attempt === "queue") {
      const queue = createAccountTurnQueue(sql, ENCRYPTION_KEY);
      await expect(queue.accept(caller, { id: sandboxId, prompt: "new work" })).rejects.toThrow(
        "Sandbox cannot accept a queued prompt.",
      );
    } else {
      await expect(deleteSandboxWithActivity(sandboxes, providers, sandboxId)).rejects.toMatchObject({
        code: "sandbox_not_ready",
      });
      expect(remove).toHaveBeenCalledTimes(1);
    }
  },
);

test("owners and admins can recover the exact native archive after normal deletion and handoff replay", async () => {
  const archive = Buffer.from("detached work fixture").toString("base64");
  const previousKey = process.env.ARMADA_ENCRYPTION_KEY;
  process.env.ARMADA_ENCRYPTION_KEY = ENCRYPTION_KEY;
  try {
    const { db, people, sandboxId, archiveId, ciphertext, copy } = await seedNativeDrainReceipt(
      await encryptSecret(archive),
    );
    expect(await copy()).toBe("archived");
    expect(await copy()).toBe("archived");
    const data = (userId: string) =>
      createSqlData(bunLikeSql(db))({ via: "service", userId, orgs: [{ orgId: people.org, role: "admin" }] }).sandboxes;
    const owner = data(people.owner);
    const token = crypto.randomUUID();
    await db.query("update sandboxes set activity_lease_id=$2,activity_until=now()+interval '1 day' where id=$1", [
      sandboxId,
      token,
    ]);
    await owner.update(sandboxId, {
      deleteCompleted: true,
      expectedGeneration: 4,
      activityToken: token,
      finishActivity: true,
    });

    expect((await owner.get(sandboxId))?.status).toBe("deleted");
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [sandboxId])).rows).toEqual([]);
    expect(await copy(5)).toBe("ineligible");
    expect(
      (
        await db.query("select archive_id,org_id,owner_id,archive_enc from native_drain_recovery where sandbox_id=$1", [
          sandboxId,
        ])
      ).rows,
    ).toEqual([{ archive_id: archiveId, org_id: people.org, owner_id: people.owner, archive_enc: ciphertext }]);
    expect(await owner.readWorkRecovery?.(sandboxId, archiveId)).toBe(archive);
    expect(await data(people.admin).readWorkRecovery?.(sandboxId)).toBe(archive);
    expect(await owner.readWorkRecovery?.(sandboxId, crypto.randomUUID())).toBeNull();
    await expect(data(people.member).readWorkRecovery?.(sandboxId, archiveId)).rejects.toMatchObject({
      code: "not_found",
    });
  } finally {
    if (previousKey === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
    else process.env.ARMADA_ENCRYPTION_KEY = previousKey;
  }
});

test("native handoff refuses stale and missing proof even with a historical archive", async () => {
  const { db, sandboxId, archiveId, copy } = await seedNativeDrainReceipt();
  expect(await copy(3)).toBe("ineligible");
  await db.query("delete from sandbox_work_recovery where id=$1", [archiveId]);
  await db.query("insert into sandbox_work_recovery(sandbox_id,archive_enc) values($1,$2)", [
    sandboxId,
    new Uint8Array([89]),
  ]);
  expect(await copy()).toBe("unverified");

  await db.query(
    "update sandbox_native_preservation_receipts set archive_id=null, capture_generation=3 where sandbox_id=$1",
    [sandboxId],
  );
  expect(await copy()).toBe("unverified");
  await db.query("update sandbox_native_preservation_receipts set capture_generation=4 where sandbox_id=$1", [
    sandboxId,
  ]);
  expect(await copy()).toBe("clean");
  expect(
    (await db.query("select archive_id from native_drain_recovery where sandbox_id=$1", [sandboxId])).rows,
  ).toEqual([]);
});

test("native drain recovery is service-only and taint purges the detached copy", async () => {
  const { db, sandboxId, copy } = await seedNativeDrainReceipt();
  const privileges = await db.query(
    `select
      has_function_privilege('authenticated','public.copy_native_drain_recovery(uuid,bigint)','execute') as jwt_copy,
      has_table_privilege('authenticated','public.native_drain_recovery','select') as jwt_read,
      has_function_privilege('service_role','public.copy_native_drain_recovery(uuid,bigint)','execute') as service_copy,
      has_table_privilege('service_role','public.native_drain_recovery','select') as service_read`,
  );
  expect(privileges.rows).toEqual([{ jwt_copy: false, jwt_read: false, service_copy: true, service_read: true }]);
  expect(await copy()).toBe("archived");
  await db.query("update sandboxes set application_secret_tainted=true where id=$1", [sandboxId]);
  expect(await copy()).toBe("ineligible");
  expect(
    (await db.query("select archive_id from native_drain_recovery where sandbox_id=$1", [sandboxId])).rows,
  ).toEqual([]);
});

test.each(["prompt", "steer", "queued", "dispatching"] as const)(
  "native handoff leaves verified work attached while %s work is unresolved",
  async (kind) => {
    const { db, sandboxId, copy } = await seedNativeDrainReceipt();
    let settle: string;
    if (kind === "prompt") {
      await db.query(
        `insert into native_webhook_prompts(sandbox_id,prompt_id,provider,provider_sandbox_id,owner_id,org_id,failures)
         select id,'turn',provider,provider_sandbox_id,owner_id,org_id,5 from sandboxes where id=$1`,
        [sandboxId],
      );
      settle = "update native_webhook_prompts set completed_at=now() where sandbox_id=$1";
    } else if (kind === "steer") {
      await db.query(
        "insert into native_steer_cursors(sandbox_id,steer_id,pending_since,pending_steers) values($1,gen_random_uuid(),now(),1)",
        [sandboxId],
      );
      settle = "update native_steer_cursors set pending_since=null,pending_steers=0 where sandbox_id=$1";
    } else {
      await db.query(
        `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,
           actor_epoch,credential_version,input_hash,input_enc,conversation_id,state,dispatch_generation)
         select s.id,gen_random_uuid(),c.id,s.owner_id,s.org_id,1,c.version,'input',$3,'conversation',$2,
           case when $2='dispatching' then s.lifecycle_generation end
         from sandboxes s join credentials c on c.owner_id=s.org_id and c.kind='openai'
         where s.id=$1 limit 1`,
        [sandboxId, kind, new Uint8Array([1])],
      );
      settle = "update account_turn_queue set state='admitted' where sandbox_id=$1";
    }

    expect(await copy()).toBe("ineligible");
    expect((await db.query("select 1 from native_drain_recovery where sandbox_id=$1", [sandboxId])).rows).toEqual([]);
    await db.query(settle, [sandboxId]);
    expect(await copy()).toBe(kind === "prompt" ? "ineligible" : "archived");
  },
);

async function seedCompletedPromptProof(
  db: ReturnType<typeof sharedDatabase>["db"],
  sandboxId: string,
  promptId: string,
) {
  await db.query(
    `update sandbox_native_preservation_receipts
     set capture_acknowledgements=jsonb_build_object('completedPrompts',jsonb_build_array($2::text))
     where sandbox_id=$1`,
    [sandboxId, promptId],
  );
}

test.each([
  ["Dispatch outcome uncertain; inspect sandbox history before resending.", false, "ineligible", false],
  [
    "Queued receipt already has dispatch evidence; inspect sandbox history before resending.",
    false,
    "ineligible",
    false,
  ],
  ["Dispatch cancelled by confirmed stop.", false, "ineligible", false],
  ["Dispatch refused by owner stop.", true, "ineligible", false],
  ["Dispatch refused by owner stop.", false, "archived", false],
  ["Queued prompt was cancelled.", false, "ineligible", true],
] as const)(
  "native handoff classifies failed receipt %s with retained claim %p",
  async (reason, claimed, outcome, currentTask) => {
    const { db, sandboxId, copy } = await seedNativeDrainReceipt();
    const requestId = crypto.randomUUID();
    await db.query(
      `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,
       actor_epoch,credential_version,input_hash,input_enc,conversation_id,state,
       dispatch_generation,dispatch_until,failure_reason)
     select s.id,$5,c.id,s.owner_id,s.org_id,1,c.version,'input',$4,'conversation','failed',
       case when $2 then s.lifecycle_generation end,case when $2 then now() end,$3
     from sandboxes s join credentials c on c.owner_id=s.org_id and c.kind='openai'
     where s.id=$1 limit 1`,
      [sandboxId, claimed, reason, new Uint8Array([1]), requestId],
    );
    if (currentTask) {
      await db.query("update sandboxes set task_prompt_id=$2 where id=$1", [sandboxId, requestId]);
      await db.query("update native_webhook_prompts set completed_at=now() where sandbox_id=$1", [sandboxId]);
      await seedCompletedPromptProof(db, sandboxId, requestId);
    }
    await db.query("update sandboxes set stopped_at=now() where id=$1", [sandboxId]);

    expect(await copy()).toBe(outcome);
    if (outcome === "ineligible")
      expect((await db.query("select 1 from native_drain_recovery where sandbox_id=$1", [sandboxId])).rows).toEqual([]);
  },
);

test("native handoff refuses a failed receipt even when an unrelated prompt was aliased and settled", async () => {
  const { db, sandboxId, copy } = await seedNativeDrainReceipt();
  await db.query(
    `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,
       actor_epoch,credential_version,input_hash,input_enc,conversation_id,state,dispatch_generation,dispatch_until)
     select s.id,gen_random_uuid(),c.id,s.owner_id,s.org_id,1,c.version,'input',$2,'conversation',
       'dispatching',s.lifecycle_generation,now()
     from sandboxes s join credentials c on c.owner_id=s.org_id and c.kind='openai'
     where s.id=$1 limit 1`,
    [sandboxId, new Uint8Array([1])],
  );
  await db.query("update sandboxes set task_prompt_id='unrelated-turn' where id=$1", [sandboxId]);
  await db.query(
    "update native_webhook_prompts set completed_at=now() where sandbox_id=$1 and prompt_id='unrelated-turn'",
    [sandboxId],
  );
  const { rows } = await db.query(
    `update account_turn_queue set state='failed', dispatch_generation=null, dispatch_until=null
     where sandbox_id=$1 returning native_prompt_id`,
    [sandboxId],
  );
  expect(rows).toEqual([{ native_prompt_id: "unrelated-turn" }]);
  await seedCompletedPromptProof(db, sandboxId, "unrelated-turn");

  expect(await copy()).toBe("ineligible");
  expect((await db.query("select 1 from native_drain_recovery where sandbox_id=$1", [sandboxId])).rows).toEqual([]);
});

test.each([
  ["failed dispatch", "before clean capture", "clean"],
  ["ordinary prompt", "before clean capture", "clean"],
  ["failed dispatch", "during clean capture", "ineligible"],
  ["ordinary prompt", "during clean capture", "ineligible"],
  ["failed dispatch", "before archive capture", "archived"],
] as const)("native %s settled %s requires matching capture evidence", async (kind, settlement, outcome) => {
  await withPreservationRow(async ({ db, id, physical, sql, boat, provider, generation }) => {
    const token = crypto.randomUUID();
    const requestId = kind === "failed dispatch" ? crypto.randomUUID() : null;
    if (requestId)
      await db.query(
        `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,
           actor_epoch,credential_version,input_hash,input_enc,conversation_id,state,dispatch_generation)
         select s.id,$2,c.id,s.owner_id,s.org_id,1,c.version,'input',$3,'conversation',
           'dispatching',s.lifecycle_generation
         from sandboxes s join credentials c on c.owner_id=s.org_id and c.kind='openai' where s.id=$1 limit 1`,
        [id, requestId, new Uint8Array([1])],
      );
    await db.query(
      `insert into native_webhook_prompts
           (sandbox_id,prompt_id,provider,provider_sandbox_id,owner_id,org_id,acknowledged_request_id)
         select id,'bound-turn',provider,provider_sandbox_id,owner_id,org_id,$2 from sandboxes where id=$1`,
      [id, requestId],
    );
    const settlePrompt = () =>
      db.query("update native_webhook_prompts set completed_at=now() where sandbox_id=$1", [id]);
    await db.query(
      `update sandboxes set status='stopping',stop_requested_at=now(),stop_generation=1,
           activity_lease_id=$2,activity_until=now()+interval '2 minutes' where id=$1`,
      [id, token],
    );
    const archive = Buffer.from("exact failed request work").toString("base64");
    const archived = outcome === "archived";
    boat.setExecOutput({ stdout: archived ? '{"status":"preserved"}' : '{"status":"clean"}' });
    const exec = archived ? encryptedRecoveryExec(() => archive, provider.exec) : provider.exec;
    let captures = 0;
    const host = {
      ...provider,
      async quiesce() {
        if (settlement !== "during clean capture") await settlePrompt();
      },
      async exec(request: Parameters<typeof provider.exec>[0]) {
        if (request.preservationStage !== "chunk_exec") {
          captures++;
          if (settlement === "during clean capture") await settlePrompt();
        }
        return exec(request);
      },
    };
    const authority = { kind: "activity", token, generation } as const;
    const previousKey = process.env.ARMADA_ENCRYPTION_KEY;
    process.env.ARMADA_ENCRYPTION_KEY = ENCRYPTION_KEY;
    try {
      await preserveBeforeStop(sql, host, id, physical, "user_stop", authority);
      await preserveBeforeStop(sql, host, id, physical, "user_stop", authority);
    } finally {
      if (previousKey === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
      else process.env.ARMADA_ENCRYPTION_KEY = previousKey;
    }
    expect(captures).toBe(1);

    await db.query(
      "update account_turn_queue set state='failed',failure_reason='Dispatch cancelled by confirmed stop.' where sandbox_id=$1",
      [id],
    );
    const { people } = sharedDatabase();
    const owner = createSqlData(sql)({
      via: "service",
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "admin" }],
    }).sandboxes;
    await owner.update(id, {
      ownerStop: true,
      status: "stopped",
      stoppedAt: new Date(0).toISOString(),
      stopRequested: false,
      finishActivity: true,
      expectedGeneration: generation,
      activityToken: token,
    });
    const copy = async () =>
      (
        await db.query<{ outcome: string }>("select copy_native_drain_recovery($1,$2) as outcome", [
          id,
          Number(generation) + 1,
        ])
      ).rows[0]?.outcome;
    expect(await copy()).toBe(outcome);
    if (archived) {
      const {
        rows: [detached],
      } = await db.query<{ archive_enc: Uint8Array<ArrayBuffer> }>(
        "select archive_enc from native_drain_recovery where sandbox_id=$1",
        [id],
      );
      expect(detached).toBeDefined();
      expect(await decryptSecret(detached!.archive_enc, ENCRYPTION_KEY)).toBe(archive);
    }
    if (outcome === "clean" && requestId) {
      await db.query(
        `update sandbox_native_preservation_receipts
         set capture_acknowledgements=capture_acknowledgements-'prompts' where sandbox_id=$1`,
        [id],
      );
      expect(await copy()).toBe("ineligible");
    }
    if (outcome === "clean" && !requestId) {
      await db.query("update sandbox_native_preservation_receipts set archive_id=null where sandbox_id=$1", [id]);
      expect(await copy()).toBe("ineligible");
    }
  });
});

test("native stop retries a failed acknowledgement snapshot before collecting work", async () => {
  await withPreservationRow(async ({ db, id, physical, boat, provider, generation }) => {
    const token = crypto.randomUUID();
    await db.query(
      `update sandboxes set status='stopping',stop_requested_at=now(),stop_generation=1,
         activity_lease_id=$2,activity_until=now()+interval '2 minutes' where id=$1`,
      [id, token],
    );
    const sql = bunLikeSql(db, (statement) => {
      if (statement.includes("jsonb_object_agg(p.acknowledged_request_id"))
        throw new Error("acknowledgement snapshot unavailable");
    });
    const authority = { kind: "activity", token, generation } as const;
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    expect(await preserveBeforeStop(sql, provider, id, physical, "user_stop", authority)).toBe("pending");
    expect(boat.execs).toHaveLength(0);
    expect(await preserveBeforeStop(bunLikeSql(db), provider, id, physical, "user_stop", authority)).toBeUndefined();
    expect(boat.execs).toHaveLength(1);
  });
});
