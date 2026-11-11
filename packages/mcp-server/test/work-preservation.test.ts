import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { decryptSecret, ProviderError } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { preserveBeforeStop } from "../src/work-preservation.ts";
import { encryptedRecoveryExec } from "./fixtures/recovery-exec.ts";
import { bunLikeSql, database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

// Primary owner for encrypted persistence and recovery authorization. Collector behavior
// (including actual Git reconstruction) belongs to core's work-preservation test.
test("recovery receipts retain encrypted versions and only current interior owners/admins can retrieve them", async () => {
  const oldKey = process.env.ARMADA_ENCRYPTION_KEY;
  process.env.ARMADA_ENCRYPTION_KEY = ENCRYPTION_KEY;
  const { db, people } = await database();
  try {
    const sql = bunLikeSql(db);
    const id = crypto.randomUUID();
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw new Error("Missing golden fixture");
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
      values($1,$2,$3,$4,'boat','bx_recovery','claude','running')`,
      [id, golden.id, people.org, people.owner],
    );
    const data = (userId: string, orgId = people.org) =>
      createSqlData(sql)({ via: "service", userId, orgs: [{ orgId, role: "admin" }] }).sandboxes;
    const owner = data(people.owner);
    const boat = fakeBoat();
    let currentArchive = "";
    const provider = {
      ...boat.provider,
      async interrupt() {
        throw new Error("idle harness must not be interrupted");
      },
      async quiesce() {},
      async get() {
        return { id: "bx_recovery", name: "recovery", state: "ready" as const, providerState: "running", labels: {} };
      },
      exec: encryptedRecoveryExec(() => currentArchive, boat.provider.exec),
    };
    const captured = (archive: string) => {
      currentArchive = archive;
      return JSON.stringify({
        status: "preserved",
        bytes: Buffer.from(archive, "base64").length,
        sha256: createHash("sha256").update(Buffer.from(archive, "base64")).digest("hex"),
      });
    };
    const archive = Buffer.from("recovery fixture one: private repository material").toString("base64");
    boat.setExecOutput({ stdout: captured(archive) });
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
    await preserveBeforeStop(sql, provider, id, "bx_recovery");
    const first = (
      await db.query<{ id: string; archive_enc: Uint8Array<ArrayBuffer> }>(
        "select id,archive_enc from sandbox_work_recovery where sandbox_id=$1",
        [id],
      )
    ).rows[0];
    if (!first) throw new Error("Missing recovery artifact");
    expect(Buffer.from(first.archive_enc).includes(Buffer.from(archive))).toBe(false);
    expect(await decryptSecret(first.archive_enc)).toBe(archive);
    expect((await owner.get(id))?.preservationNote).toBe(`unpushed work preserved at work_recovery:${id}/${first.id}`);
    expect(await owner.readWorkRecovery?.(id)).toBe(archive);

    // A clean retry clears the current banner without losing recovery data.
    await db.query("update sandboxes set preservation_note='old failure' where id=$1", [id]);
    // Clean stops do not create archives; historical archives remain retrievable.
    boat.setExecOutput({ stdout: JSON.stringify({ status: "clean" }) });
    await preserveBeforeStop(sql, provider, id, "bx_recovery");
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(1);
    expect((await owner.get(id))?.preservationNote).toBeNull();

    // Retrying after failed capture surfaces a closed reason without losing earlier data.
    boat.setExecOutput({ stdout: JSON.stringify({ status: "failed", reason: "collector_failed" }) });
    await preserveBeforeStop(sql, provider, id, "bx_recovery");
    expect(await owner.readWorkRecovery?.(id, first.id)).toBe(archive);

    await db.query("update sandbox_work_recovery set created_at='2020-01-01' where id=$1", [first.id]);
    const newerArchive = Buffer.from("recovery fixture two").toString("base64");
    boat.setExecOutput({ stdout: captured(newerArchive) });
    await preserveBeforeStop(sql, provider, id, "bx_recovery");
    expect(await owner.readWorkRecovery?.(id)).toBe(newerArchive);
    expect(await owner.readWorkRecovery?.(id, first.id)).toBe(archive);
    expect(await data(people.admin).readWorkRecovery?.(id)).toBe(newerArchive);
    // Stale admin claims cannot upgrade an ordinary org member's interior access.
    await expect(data(people.member).readWorkRecovery?.(id, first.id)).rejects.toThrow("No such sandbox");
    await expect(data(people.member, people.otherOrg).readWorkRecovery?.(id)).rejects.toThrow("No such sandbox");
    const otherId = crypto.randomUUID();
    expect(await owner.readWorkRecovery?.(id, otherId)).toBeNull();

    // Ciphertext is not directly readable with a dashboard user's database role.
    await db.exec("set role authenticated");
    try {
      await expect(db.query("select archive_enc from sandbox_work_recovery")).rejects.toThrow("permission denied");
    } finally {
      await db.exec("reset role");
    }
  } finally {
    await db.close();
    if (oldKey === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
    else process.env.ARMADA_ENCRYPTION_KEY = oldKey;
  }
});

// Distinct lifecycle contract: a timed-out observation must never admit later
// interrupt/exec work after the caller is free to stop the machine.
test.each(["observe", "quiesce", "capture", "known_capture"])(
  "the stop deadline fences late %s work",
  async (stage) => {
    const { db, people } = await database();
    const originalTimeout = globalThis.setTimeout;
    try {
      const sql = bunLikeSql(db);
      const id = crypto.randomUUID();
      const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
      if (!golden) throw new Error("Missing golden fixture");
      await db.query(
        `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
      values($1,$2,$3,$4,'boat','bx_late_recovery','claude','running')`,
        [id, golden.id, people.org, people.owner],
      );
      const boat = fakeBoat();
      const info = {
        id: "bx_late_recovery",
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
      const stopped = preserveBeforeStop(sql, provider, id, "bx_late_recovery");
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
      await db.close();
    }
  },
);

async function withPreservationRow(
  work: (fixture: {
    db: Awaited<ReturnType<typeof database>>["db"];
    sql: ReturnType<typeof bunLikeSql>;
    id: string;
    boat: ReturnType<typeof fakeBoat>;
    provider: ReturnType<typeof fakeBoat>["provider"];
  }) => Promise<void>,
) {
  const { db, people } = await database();
  try {
    const id = crypto.randomUUID();
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw new Error("Missing golden");
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status)
      values($1,$2,$3,$4,'boat','bx_policy','claude','running')`,
      [id, golden.id, people.org, people.owner],
    );
    const boat = fakeBoat();
    const provider = {
      ...boat.provider,
      get: async () => ({
        id: "bx_policy",
        name: "policy",
        state: "ready" as const,
        providerState: "idle",
        labels: {},
      }),
      quiesce: async () => {},
    };
    await work({ db, id, boat, provider, sql: bunLikeSql(db) });
  } finally {
    await db.close();
  }
}

test("confirmed work at risk records a closed stage/reason and owner action", async () => {
  await withPreservationRow(async ({ db, id, sql, boat, provider }) => {
    boat.setExecOutput({ stdout: JSON.stringify({ status: "failed", reason: "size_limit", workAtRisk: true }) });
    await preserveBeforeStop(sql, provider, id, "bx_policy");
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
    await withPreservationRow(async ({ db, id, sql, provider }) => {
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
          "bx_policy",
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
  await withPreservationRow(async ({ db, id, sql, provider }) => {
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
      "bx_policy",
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
  await withPreservationRow(async ({ db, id, boat, provider }) => {
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    let failed = false;
    const sql = bunLikeSql(db, (text) => {
      if (!failed && /^\s*update/i.test(text)) {
        failed = true;
        throw new Error("Synthetic cleanup failure");
      }
    });
    await preserveBeforeStop(sql, provider, id, "bx_policy");
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
  await withPreservationRow(async ({ db, id, sql, boat, provider }) => {
    await db.query("update sandboxes set stop_requested_at='2026-11-11T08:00:00Z',stop_generation=1 where id=$1", [id]);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const late = {
      ...provider,
      get: () =>
        new Promise<Awaited<ReturnType<typeof provider.get>>>((resolve) => {
          release = () => {
            void provider.get("bx_policy").then(resolve);
          };
          entered?.();
        }),
      exec: async () => {
        throw new ProviderError({
          provider: "boat",
          code: "sandbox_not_ready",
          retryable: false,
          message: "Archiving",
        });
      },
    };
    const failed = preserveBeforeStop(sql, late, id, "bx_policy", "lifecycle_stop");
    await ready;
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    await preserveBeforeStop(sql, provider, id, "bx_policy", "user_stop");
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

test("a fresh stop epoch does not reuse an earlier clean capture", async () => {
  await withPreservationRow(async ({ db, id, sql, boat, provider }) => {
    boat.setExecOutput({ stdout: '{"status":"clean"}' });
    await db.query("update sandboxes set stop_requested_at='2026-11-11T08:00:00Z',stop_generation=1 where id=$1", [id]);
    await preserveBeforeStop(sql, provider, id, "bx_policy");
    const count = boat.execs.length;
    await db.query("update sandboxes set stop_requested_at='2026-11-11T09:00:00Z',stop_generation=2 where id=$1", [id]);
    await preserveBeforeStop(sql, provider, id, "bx_policy");
    expect(boat.execs.length).toBe(count + 1);
  });
});

test("a user JWT cannot forge the successful stop marker", async () => {
  await withPreservationRow(async ({ db }) => {
    await db.exec("set role authenticated");
    try {
      await expect(db.query("insert into sandboxes(preservation_stop_generation) values(1)")).rejects.toThrow(
        "permission denied",
      );
    } finally {
      await db.exec("reset role");
    }
  });
});
