import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "@armada/core/server";
import { readOutputDirectory } from "../../agent-runtime/src/outputs.ts";
import { captureDockerStopOutputs, createDockerOutputReader } from "../src/docker-outputs.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
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
  const hold: { gate: Promise<void> | null } = { gate: null };
  let loop = Promise.resolve();
  // The reader's poll wait stands in for the runtime's command loop: it takes the head command
  // over the real session fence and answers it with the runtime's own directory read.
  const clock = {
    now: () => Date.now(),
    async wait() {
      if (hold.gate) await hold.gate;
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
    const result = { files: await readOutputDirectory(outputs) };
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
  return { db, people, id, sql, outputs, ops, runtime, reader, service, download, cleanup, hold };
}

test("a Docker file produced while live is sampled through the runtime and stays downloadable after stop", async () => {
  const f = await fixture();
  try {
    mkdirSync(f.outputs);
    writeFileSync(join(f.outputs, "memo.pdf"), "document");
    expect(await f.service.reconcileOne(new AbortController().signal)).toBe(true);
    await f.service.drain();
    expect(f.ops).toEqual(["readOutputs"]);
    // Reads are fresh data, not runtime history: the answered command is removed.
    expect(
      (await f.db.query(`select 1 from runtime_commands where sandbox_id=$1 and request_id like 'outputs_%'`, [f.id]))
        .rows,
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
    await captureDockerStopOutputs(f.sql, ENCRYPTION_KEY, f.id, { reader: f.reader });
    expect(await (await f.download("memo.txt"))?.text()).toBe("final");
    // Once the stop is admitted the runtime fence refuses commands: a later read cannot happen,
    // which is why every Armada Docker stop captures before it enqueues the stop.
    await f.db.query(`update sandboxes set stop_requested_at=now() where id=$1`, [f.id]);
    expect(await f.reader(f.id).readOutputs!({ sandboxId: f.id })).toBeNull();
    expect(f.ops).toEqual(["readOutputs", "readOutputs"]);
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
  const until = async (count: number) => {
    for (let i = 0; i < 200 && (await queued()) < count; i++) await Bun.sleep(10);
    expect(await queued()).toBe(count);
  };
  try {
    mkdirSync(f.outputs);
    writeFileSync(join(f.outputs, "memo.txt"), "draft");
    let release = () => {};
    f.hold.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The periodic sample is queued and awaits its reply.
    expect(await f.service.reconcileOne(new AbortController().signal)).toBe(true);
    await until(1);
    writeFileSync(join(f.outputs, "memo.txt"), "final");
    // The pre-stop capture queues its own read behind the sample's instead of skipping.
    const capture = captureDockerStopOutputs(f.sql, ENCRYPTION_KEY, f.id, { reader: f.reader });
    await until(2);
    release();
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
    expect(f.ops).toEqual(["readOutputs", "readOutputs"]);
    await f.db.query(`update sandboxes set status='stopped',stopped_at=now() where id=$1`, [f.id]);
    const response = await f.download("memo.txt");
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("final");
  } finally {
    f.hold.gate = null;
    f.cleanup();
  }
});

test("a Docker read still refuses to pile up behind two unanswered reads", async () => {
  const f = await fixture();
  try {
    for (const n of [1, 2])
      await f.runtime.enqueue(f.people.owner, {
        version: 1,
        requestId: `outputs_${Date.now()}_${n}`,
        sandboxId: f.id,
        op: "readOutputs",
      });
    expect(await f.reader(f.id).readOutputs!({ sandboxId: f.id })).toBeNull();
    expect(f.ops).toEqual([]);
  } finally {
    f.cleanup();
  }
});
