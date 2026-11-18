import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptSecret, type Sql } from "@armada/core/server";
import { readOutputDirectory, readOutputPart } from "../../agent-runtime/src/outputs.ts";
import { captureDockerStopOutputs, createDockerOutputReader } from "../src/docker-outputs.ts";
import { observeRequest } from "../src/request-observability.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeSelfFinish, selfFinishToken } from "../src/sandbox-finish.ts";
import { createSandboxOutputs } from "../src/sandbox-outputs.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const database = rowOnlyDatabase();

/** A live, enrolled Docker sandbox whose runtime answers `readOutputs` from a fixture home. */
async function fixture() {
  const { db, people } = await database();
  const host = crypto.randomUUID(),
    installation = crypto.randomUUID(),
    id = crypto.randomUUID(),
    generation = crypto.randomUUID();
  await db.query(
    `insert into docker_hosts(id,org_id,owner_id,registration_expires_at,installation_id,hash)
    values($1,$2,$3,now()-interval '1 day',$4,$5)`,
    [host, people.org, people.member, installation, "d".repeat(64)],
  );
  await db.query(
    `insert into sandboxes(id,org_id,owner_id,provider,provider_sandbox_id,harness,status,
    docker_host_id,docker_installation_id,docker_generation,docker_image,expires_at)
    values($1,$2,$3,'docker',$4,'codex','ready',$5,$6,$7,$8,now()+interval '1 hour')`,
    [
      id,
      people.org,
      people.owner,
      `armada-${installation}-${host}-${id}-${generation}`,
      host,
      installation,
      generation,
      `ubuntu@sha256:${"a".repeat(64)}`,
    ],
  );
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const issuer = createRuntimeEnrolments(sql, ENCRYPTION_KEY, { allowDockerIssue: true });
  const ticket = await issuer.issue({ sandboxId: id, ownerId: people.owner, configuration: {} });
  const session = await createRuntimeEnrolments(sql, ENCRYPTION_KEY).enrol(ticket.enrolmentToken);
  const home = mkdtempSync(join(tmpdir(), "docker-home-"));
  const outputs = join(home, "outputs");
  const runtime = createRuntimeCommands(createRuntimeEnrolments(sql, ENCRYPTION_KEY), ENCRYPTION_KEY);
  const ops: string[] = [];
  // When set, the runtime holds its queue until the gate opens (a slow in-flight read).
  const hold: { gate: Promise<void> | null; onWait?: () => void } = { gate: null };
  // When set, the runtime answers HTTP 200 with this result instead of its directory read.
  const forced: { result?: unknown } = {};
  let loop = Promise.resolve();
  // The reader's poll wait stands in for the runtime's command loop: it takes the head command
  // over the real session fence and answers it with the runtime's own directory read.
  const clock = {
    now: () => Date.now(),
    async wait() {
      if (hold.gate) {
        hold.onWait?.();
        await hold.gate;
      }
      // A real runtime runs one command loop: concurrent readers share it, never race it.
      const turn = loop.then(answer);
      loop = turn.catch(() => {});
      await turn;
    },
  };
  async function answer() {
    const { command } = await runtime.next(session.runtimeToken, session.epoch);
    if (!command) return;
    ops.push(command.op);
    let result = forced.result;
    if (!("result" in forced)) {
      if (command.op !== "readOutputs" || command.part === undefined) {
        result = { files: await readOutputDirectory(outputs) };
      } else {
        result = {
          values:
            command.part === null ? await readOutputPart(null, outputs) : await readOutputPart(command.part, outputs),
        };
      }
    }
    await runtime.complete(session.runtimeToken, session.epoch, {
      epoch: session.epoch,
      requestId: command.requestId,
      status: 200,
      body: { version: 1, requestId: command.requestId, result },
    });
  }
  const reader = createDockerOutputReader(sql, ENCRYPTION_KEY, clock);
  const service = createSandboxOutputs(
    sql,
    ENCRYPTION_KEY,
    async () => {
      throw Error("Docker never resolves a Boat/Modal provider");
    },
    reader,
  );
  const download = async (name: string) => {
    const route = service.route(async () => ({
      ok: true,
      caller: { userId: people.owner, via: "service", orgs: [{ orgId: people.org, role: "member" }] },
    }));
    return route(new Request(`https://armada.example/api/v1/sandboxes/${id}/outputs/${name}`));
  };
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  return { db, people, id, sql, session, outputs, ops, runtime, reader, service, download, cleanup, hold, forced };
}

test("a Docker file produced while live is sampled through the runtime and stays downloadable after stop", async () => {
  const f = await fixture();
  try {
    mkdirSync(f.outputs);
    writeFileSync(join(f.outputs, "memo.pdf"), "document");
    expect(await f.service.reconcileOne(new AbortController().signal)).toBe(true);
    await f.service.drain();
    expect(f.ops).toEqual(["readOutputs", "readOutputs"]);
    const lastRead = (
      await f.db.query<{ request_id: string; result_enc: Uint8Array<ArrayBuffer> }>(
        "select request_id,result_enc from runtime_commands where sandbox_id=$1 order by sequence desc limit 1",
        [f.id],
      )
    ).rows[0]!;
    expect(JSON.parse(await decryptSecret(lastRead.result_enc, ENCRYPTION_KEY)).body).toEqual({
      requestId: lastRead.request_id,
      error: "output_consumed",
    });
    // A retry of the completed chunk acknowledgement still succeeds.
    expect(
      await f.runtime.complete(f.session.runtimeToken, f.session.epoch, {
        requestId: lastRead.request_id,
        epoch: f.session.epoch,
        status: 200,
        body: { requestId: lastRead.request_id },
      }),
    ).toMatchObject({ requestId: lastRead.request_id });

    // The answered read stays (the runtime may still retry its acknowledgement) until a later
    // answer proves it was acknowledged; it never holds the queue.
    expect(
      (
        await f.db.query(
          `select 1 from runtime_commands where sandbox_id=$1 and request_id like 'outputs_%' and result_enc is null`,
          [f.id],
        )
      ).rows,
    ).toHaveLength(0);
    await f.db.query(`update sandboxes set status='stopped',stopped_at=now() where id=$1`, [f.id]);
    const response = await f.download("memo.pdf");
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("document");
  } finally {
    f.cleanup();
  }
});

test("an Armada Docker stop captures the final bytes before admission, after which the runtime refuses reads", async () => {
  const f = await fixture();
  try {
    mkdirSync(f.outputs);
    writeFileSync(join(f.outputs, "memo.txt"), "draft");
    expect(await f.service.reconcileOne(new AbortController().signal)).toBe(true);
    await f.service.drain();
    writeFileSync(join(f.outputs, "memo.txt"), "final");
    // The final manifest and chunk reads both carry the HTTP request's ID.
    const lines: string[] = [];
    const captured = await observeRequest(
      async () => {
        await captureDockerStopOutputs(f.sql, ENCRYPTION_KEY, f.id, { reader: f.reader });
        return new Response(null, { status: 202 });
      },
      (line) => lines.push(line),
    );
    expect(await (await f.download("memo.txt"))?.text()).toBe("final");
    // Once the stop is admitted the runtime fence refuses commands: a later read cannot happen,
    // which is why every Armada Docker stop captures before it enqueues the stop.
    await f.db.query(`update sandboxes set stop_requested_at=now() where id=$1`, [f.id]);
    const refused = await observeRequest(
      async () => {
        expect(await f.reader(f.id).readOutputs!({ sandboxId: f.id })).toBeNull();
        return new Response(null, { status: 409 });
      },
      (line) => lines.push(line),
    );
    expect(f.ops).toEqual(Array(4).fill("readOutputs"));
    // The refusal keeps its quiet public fallback, but the trace no longer reads as a success.
    expect(lines.map((line) => JSON.parse(line)).filter((event) => event.event === "provider_call")).toEqual([
      expect.objectContaining({
        requestId: captured?.headers.get("x-request-id"),
        provider: "docker",
        operation: "runtime.readOutputs",
        outcome: "ok",
      }),
      expect.objectContaining({
        requestId: captured?.headers.get("x-request-id"),
        provider: "docker",
        operation: "runtime.readOutputs",
        outcome: "ok",
      }),
      expect.objectContaining({
        requestId: refused?.headers.get("x-request-id"),
        operation: "runtime.readOutputs",
        outcome: "error",
      }),
    ]);
  } finally {
    f.cleanup();
  }
});

test("a well-formed Docker read reply that Armada rejects keeps the snapshot and is recorded as an error", async () => {
  const f = await fixture();
  try {
    mkdirSync(f.outputs);
    writeFileSync(join(f.outputs, "memo.txt"), "draft");
    expect(await f.service.reconcileOne(new AbortController().signal)).toBe(true);
    await f.service.drain();
    f.forced.result = { files: "invalid" };
    const lines: string[] = [];
    const response = await observeRequest(
      async () => {
        expect(await f.reader(f.id).readOutputs!({ sandboxId: f.id })).toBeNull();
        return new Response(null, { status: 202 });
      },
      (line) => lines.push(line),
    );
    expect(f.ops).toEqual(Array(3).fill("readOutputs"));
    expect(await (await f.download("memo.txt"))?.text()).toBe("draft");
    expect(lines.map((line) => JSON.parse(line)).filter((event) => event.event === "provider_call")).toEqual([
      expect.objectContaining({
        requestId: response?.headers.get("x-request-id"),
        provider: "docker",
        operation: "runtime.readOutputs",
        outcome: "error",
      }),
    ]);
  } finally {
    f.cleanup();
  }
});

test("a Docker read never queues behind an unanswered runtime command; the previous snapshot stays", async () => {
  const f = await fixture();
  try {
    await f.runtime.enqueue(f.people.owner, { version: 1, requestId: "pending_health", sandboxId: f.id, op: "health" });
    expect(await f.reader(f.id).readOutputs!({ sandboxId: f.id })).toBeNull();
    expect(
      (await f.db.query(`select 1 from runtime_commands where sandbox_id=$1 and request_id like 'outputs_%'`, [f.id]))
        .rows,
    ).toHaveLength(0);
    expect(f.ops).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("a Docker stop during an in-flight sample queues its final read behind it before admission", async () => {
  const f = await fixture();
  const queued = async () =>
    (
      await f.db.query<{ request_id: string }>(
        `select request_id from runtime_commands where sandbox_id=$1 and request_id like 'outputs_%' and result_enc is null`,
        [f.id],
      )
    ).rows.length;
  const gate = Promise.withResolvers<void>();
  const sampleQueued = Promise.withResolvers<void>();
  const captureQueued = Promise.withResolvers<void>();
  f.hold.gate = gate.promise;
  f.hold.onWait = sampleQueued.resolve;
  let capture: Promise<void> | undefined;
  try {
    mkdirSync(f.outputs);
    writeFileSync(join(f.outputs, "memo.txt"), "draft");
    // The periodic sample is queued and awaits its reply.
    expect(await f.service.reconcileOne(new AbortController().signal)).toBe(true);
    await sampleQueued.promise;
    expect(await queued()).toBe(1);
    writeFileSync(join(f.outputs, "memo.txt"), "final");
    // The pre-stop capture queues its own read behind the sample's instead of skipping.
    f.hold.onWait = captureQueued.resolve;
    capture = captureDockerStopOutputs(f.sql, ENCRYPTION_KEY, f.id, { reader: f.reader });
    await captureQueued.promise;
    expect(await queued()).toBe(2);
    gate.resolve();
    await capture;
    // The capture's own (latest) scan is the one published, not a skip.
    const fence = await f.db.query<{ published: boolean }>(
      `select outputs_published_scan=outputs_checked_at as published from sandboxes where id=$1`,
      [f.id],
    );
    expect(fence.rows[0]?.published).toBe(true);
    // Every Armada Docker stop admits right after the capture: the runtime fence then refuses
    // the sample's reply and result poll, so only a capture taken before admission survives.
    await f.db.query(`update sandboxes set status='stopping',stop_requested_at=now() where id=$1`, [f.id]);
    await f.service.drain();
    await f.db.query(`update sandboxes set status='stopped',stopped_at=now() where id=$1`, [f.id]);
    const response = await f.download("memo.txt");
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("final");
  } finally {
    f.hold.gate = null;
    gate.resolve();
    await capture;
    await f.service.drain();
    f.cleanup();
  }
});

test("a Docker read still refuses to pile up behind two unanswered reads", async () => {
  const f = await fixture();
  try {
    for (const n of [1, 2])
      await f.runtime.enqueue(f.people.owner, {
        version: 1,
        requestId: `outputs_${Date.now() + 25_000}_${n}`,
        sandboxId: f.id,
        op: "readOutputs",
      });
    expect(await f.reader(f.id).readOutputs!({ sandboxId: f.id })).toBeNull();
    expect(f.ops).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("a timed-out Docker read stops holding the runtime queue and is removed only once it cannot be acknowledged", async () => {
  const f = await fixture();
  try {
    // The runtime takes the first read but never answers in time: the fake clock only advances.
    let t = Date.now();
    const runtime = createRuntimeCommands(createRuntimeEnrolments(f.sql, ENCRYPTION_KEY), ENCRYPTION_KEY, {
      now: () => t,
      async wait() {},
    });
    let delivered: string | undefined;
    const clock = {
      now: () => t,
      async wait(ms: number) {
        delivered ??= (await runtime.next(f.session.runtimeToken, f.session.epoch)).command?.requestId;
        t += ms;
      },
    };
    const reader = createDockerOutputReader(f.sql, ENCRYPTION_KEY, clock);
    const reply = (requestId: string) =>
      runtime.complete(f.session.runtimeToken, f.session.epoch, {
        epoch: f.session.epoch,
        requestId,
        status: 200,
        body: { requestId },
      });
    const reads = async () =>
      (await f.db.query(`select 1 from runtime_commands where sandbox_id=$1 and request_id like 'outputs_%'`, [f.id]))
        .rows.length;
    expect(await reader(f.id).readOutputs!({ sandboxId: f.id })).toBeNull();
    expect(delivered).toStartWith("outputs_");
    // A new read neither waits behind nor deletes the delivered, expired read: its late
    // acknowledgement still succeeds instead of failing (and being retried) forever.
    expect(await reader(f.id).readOutputs!({ sandboxId: f.id })).toBeNull();
    expect(await reads()).toBe(2);
    await reply(delivered!);
    // A later command is dispatched ahead of the second expired read, which is never delivered.
    await runtime.enqueue(f.people.owner, { version: 1, requestId: "later_health", sandboxId: f.id, op: "health" });
    expect((await runtime.next(f.session.runtimeToken, f.session.epoch)).command?.requestId).toBe("later_health");
    await reply("later_health");
    // Answering a later command proves neither expired read can still be acknowledged.
    expect(await reader(f.id).readOutputs!({ sandboxId: f.id })).toBeNull();
    expect(await reads()).toBe(1);
    expect(f.ops).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("a stale Docker self-finish binding is refused before any output read", async () => {
  const f = await fixture();
  try {
    const reads: string[] = [];
    const reader = (_id: string, epoch?: string) => ({
      async readOutputs() {
        reads.push(epoch ?? "unfenced");
        return [];
      },
    });
    const generation = (
      await f.db.query<{ mcp_generation: number }>("select mcp_generation from sandboxes where id=$1", [f.id])
    ).rows[0]!.mcp_generation;
    const finish = createRuntimeSelfFinish(f.sql, ENCRYPTION_KEY, { reader });
    const binding = { sandboxId: f.id, ownerId: f.people.owner, epoch: f.session.epoch, generation };
    await expect(finish(selfFinishToken(ENCRYPTION_KEY, { ...binding, generation: generation + 1 }))).rejects.toThrow();
    await expect(finish(selfFinishToken(ENCRYPTION_KEY, { ...binding, epoch: `${binding.epoch}0` }))).rejects.toThrow();
    expect(reads).toHaveLength(0);
    // A live binding reads under exactly its validated epoch (this fixture host then refuses the stop job).
    await finish(selfFinishToken(ENCRYPTION_KEY, binding)).catch(() => {});
    expect(reads).toEqual([binding.epoch]);
  } finally {
    f.cleanup();
  }
});

test("an output read is never dispatched once a later command was answered, whatever the clock says", async () => {
  const f = await fixture();
  try {
    const read = `outputs_${Date.now() + 25_000}_skewed`;
    await f.runtime.enqueue(f.people.owner, { version: 1, requestId: read, sandboxId: f.id, op: "readOutputs" });
    await f.runtime.enqueue(f.people.owner, { version: 1, requestId: "answered", sandboxId: f.id, op: "health" });
    await f.runtime.complete(f.session.runtimeToken, f.session.epoch, {
      epoch: f.session.epoch,
      requestId: "answered",
      status: 200,
      body: { requestId: "answered" },
    });
    expect((await f.runtime.next(f.session.runtimeToken, f.session.epoch)).command).toBeNull();
  } finally {
    f.cleanup();
  }
});

test("taint committed after a Docker read was queued stops its dispatch and redacts an issued read's reply", async () => {
  const f = await fixture();
  try {
    const issued = `outputs_${Date.now() + 25_000}_issued`;
    const queued = `outputs_${Date.now() + 25_000}_queued`;
    await f.runtime.enqueue(f.people.owner, { version: 1, requestId: issued, sandboxId: f.id, op: "readOutputs" });
    await f.runtime.enqueue(f.people.owner, { version: 1, requestId: queued, sandboxId: f.id, op: "readOutputs" });
    // The first read reaches the runtime before taint commits.
    expect((await f.runtime.next(f.session.runtimeToken, f.session.epoch)).command?.requestId).toBe(issued);
    await f.db.query(`update sandboxes set application_secret_tainted=true where id=$1`, [f.id]);
    // Once taint committed, no output read is (re)dispatched.
    expect((await f.runtime.next(f.session.runtimeToken, f.session.epoch)).command).toBeNull();
    // A new read is refused at admission, and skipped reads never hold later commands.
    await expect(
      f.runtime.enqueue(f.people.owner, {
        version: 1,
        requestId: `outputs_${Date.now() + 25_000}_late`,
        sandboxId: f.id,
        op: "readOutputs",
      }),
    ).rejects.toThrow("runtime_command_conflict");
    await f.runtime.enqueue(f.people.owner, { version: 1, requestId: "later", sandboxId: f.id, op: "health" });
    expect((await f.runtime.next(f.session.runtimeToken, f.session.epoch)).command?.requestId).toBe("later");
    // A reply to a read issued before taint is acknowledged (the runtime's queue advances) without its bytes.
    for (const requestId of [issued, queued])
      await f.runtime.complete(f.session.runtimeToken, f.session.epoch, {
        epoch: f.session.epoch,
        requestId,
        status: 200,
        body: { version: 1, requestId, result: { files: [{ name: "memo.txt", content: "c2VjcmV0" }] } },
      });
    const rows = await f.db.query<{ request_id: string; result_enc: Uint8Array<ArrayBuffer> }>(
      `select request_id,result_enc from runtime_commands where sandbox_id=$1 and request_id like 'outputs_%'`,
      [f.id],
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      const stored = await decryptSecret(row.result_enc, ENCRYPTION_KEY);
      expect(stored).not.toContain("c2VjcmV0");
      expect(JSON.parse(stored)).toMatchObject({ status: 410, requestId: row.request_id });
    }
  } finally {
    f.cleanup();
  }
});
