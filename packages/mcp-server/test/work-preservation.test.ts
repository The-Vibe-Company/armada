import { expect, spyOn, test } from "bun:test";
import { constants, createCipheriv, createHash, pbkdf2Sync, publicEncrypt, randomBytes } from "node:crypto";
import { decryptSecret, ProviderError } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { preserveBeforeStop } from "../src/work-preservation.ts";
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
    let transportArchive = "";
    const provider = {
      ...boat.provider,
      async interrupt() {
        throw new Error("idle harness must not be interrupted");
      },
      async quiesce() {},
      async get() {
        return { id: "bx_recovery", name: "recovery", state: "ready" as const, providerState: "running", labels: {} };
      },
      async exec(request: Parameters<typeof boat.provider.exec>[0]) {
        if (request.command.includes("fs.readSync(fd,data,"))
          return {
            detached: false as const,
            exitCode: 0,
            stdout: transportArchive,
            stderr: "",
            timedOut: false,
            truncated: false,
          };
        const result = await boat.provider.exec(request);
        if (!result.detached && result.stdout.includes('"status":"preserved"')) {
          const publicKey = request.command
            .match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/)?.[0]
            .replaceAll("\\n", "\n");
          if (!publicKey) throw new Error("Missing collector public key");
          const password = randomBytes(32).toString("hex");
          const salt = randomBytes(8);
          const derived = pbkdf2Sync(password, salt, 10000, 48, "sha256");
          const cipher = createCipheriv("aes-256-cbc", derived.subarray(0, 32), derived.subarray(32));
          const ciphertext = Buffer.concat([
            Buffer.from("Salted__"),
            salt,
            cipher.update(Buffer.from(currentArchive, "base64")),
            cipher.final(),
          ]);
          transportArchive = ciphertext.toString("base64");
          const key = publicEncrypt(
            { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
            Buffer.from(password),
          ).toString("base64");
          return {
            ...result,
            stdout: JSON.stringify({
              status: "preserved",
              bytes: ciphertext.length,
              sha256: createHash("sha256").update(ciphertext).digest("hex"),
              key,
            }),
          };
        }
        return result;
      },
    };
    const captured = (archive: string) => {
      currentArchive = archive;
      return JSON.stringify({
        status: "preserved",
        bytes: Buffer.from(archive, "base64").length,
        sha256: createHash("sha256").update(Buffer.from(archive, "base64")).digest("hex"),
      });
    };
    // SQL receipts and logs must retain the failing boundary, not provider text.
    const log = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const [method, stage, reason] of [
        ["get", "observe", "observe_failed"],
        ["quiesce", "quiesce", "quiesce_failed"],
        ["exec", "collect_exec", "collect_exec_exec_failed"],
      ] as const) {
        const refusal = new ProviderError({
          provider: "boat",
          code: "unavailable",
          status: 502,
          retryable: true,
          message: "PRIVATE_MESSAGE",
          providerCode: "PRIVATE_CODE",
          details: { secret: "PRIVATE_BODY" },
        });
        await preserveBeforeStop(
          sql,
          {
            ...provider,
            [method]: async () => {
              throw refusal;
            },
          },
          id,
          "bx_recovery",
        );
        const closedReason = `${reason}_provider_unavailable_http_502`;
        const note = (await owner.get(id))?.preservationNote;
        expect(note).toContain(
          `(${method === "get" ? "observe_failed" : method === "quiesce" ? "quiesce_failed" : "exec_failed"})`,
        );
        expect(note).not.toContain("PRIVATE");
        const line = String(log.mock.calls.at(-1)?.[0]);
        expect(JSON.parse(line)).toMatchObject({
          event: "work_preservation_failed",
          sandboxId: id,
          stage,
          reason: closedReason,
          errorClass: "provider_unavailable",
          providerStatus: 502,
        });
        expect(line).not.toContain("PRIVATE");
      }
    } finally {
      log.mockRestore();
    }

    // Idle reviewers need no harness call, artifact, or warning, even on a retry.
    await db.query("update sandboxes set preservation_note='old failure' where id=$1", [id]);
    boat.setExecOutput({ stdout: JSON.stringify({ status: "clean" }) });
    await preserveBeforeStop(sql, provider, id, "bx_recovery");
    expect((await owner.get(id))?.preservationNote).toBeNull();
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(0);

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

    // A clean retry clears a stale failure without losing the recovery receipt.
    await db.query("update sandboxes set preservation_note='old failure' where id=$1", [id]);
    // Clean stops must neither create an archive nor hide an earlier recovery receipt.
    boat.setExecOutput({ stdout: JSON.stringify({ status: "clean" }) });
    await preserveBeforeStop(sql, provider, id, "bx_recovery");
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(1);
    expect((await owner.get(id))?.preservationNote).toContain(first.id);

    // Retrying after failed capture surfaces a closed reason without losing earlier data.
    boat.setExecOutput({ stdout: JSON.stringify({ status: "failed", reason: "collector_failed" }) });
    await preserveBeforeStop(sql, provider, id, "bx_recovery");
    expect((await owner.get(id))?.preservationNote).toBe(
      "unpushed work could not be preserved (collector_failed). Resume the sandbox and push or copy any local work before stopping again.",
    );
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
test.each(["observe", "quiesce", "capture"])("the stop deadline fences late %s work", async (stage) => {
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
            })
          : Promise.resolve(info),
      quiesce: () => {
        interrupts++;
        return stage === "capture"
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              release = resolve;
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
        return new Promise<typeof result>((resolve) => {
          release = () => resolve(result);
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
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    if (!expire || !release) throw new Error("Expected pending provider observation and deadline");
    expire();
    expect(await stopped).toBe(stage === "capture" ? undefined : "pending");
    if (stage === "capture") expect(captureSignal?.aborted).toBe(true);
    release();
    await Promise.resolve();
    await Promise.resolve();
    const row = (
      await db.query<{ preservation_note: string }>("select preservation_note from sandboxes where id=$1", [id])
    ).rows[0];
    if (stage === "capture") expect(row?.preservation_note).toContain("(timeout)");
    else expect(row?.preservation_note ?? null).toBeNull();
    expect(interrupts).toBe(stage === "observe" ? 0 : 1);
    expect(execs).toBe(stage === "capture" ? 1 : 0);
    expect((await db.query("select id from sandbox_work_recovery where sandbox_id=$1", [id])).rows).toHaveLength(0);
  } finally {
    globalThis.setTimeout = originalTimeout;
    await db.close();
  }
});
