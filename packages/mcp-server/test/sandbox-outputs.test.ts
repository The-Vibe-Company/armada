import { expect, test } from "bun:test";
import type { OutputFile, Provider, Sql } from "@armada/core/server";
import { captureFinalOutputs, createSandboxOutputs, drainFinalOutputs } from "../src/sandbox-outputs.ts";
import { preserveBeforeStop } from "../src/work-preservation.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";

const database = rowOnlyDatabase();
const KEY = Buffer.alloc(32, 7).toString("base64");
const signal = () => new AbortController().signal;
const file = (name: string, text: string): OutputFile => ({ name, bytes: new Uint8Array(Buffer.from(text)) });

async function fixture(options: { boatId: string; boatRuntime?: boolean } = { boatId: "output_fixture" }) {
  const { db, people } = await database();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,boat_runtime)
    select $1,id,org_id,owner_id,$2,'codex','ready',$3 from goldens
    where owner_id=$4 and visibility='private' limit 1`,
    [id, options.boatId, options.boatRuntime === true, people.owner],
  );
  const sql: Sql = {
    query: (q, p) => db.query(q, p),
    transaction: async (work) => {
      await db.exec("begin");
      try {
        const result = await work(sql);
        await db.exec("commit");
        return result;
      } catch (e) {
        await db.exec("rollback");
        throw e;
      }
    },
  };
  return { db, people, id, sql };
}

/** A provider stand-in: live compute until stopped; a stopped workspace is never read. */
function disks() {
  const state = {
    live: [] as OutputFile[],
    stopped: false,
    // Set: reads hang like an SDK call that ignores cancellation, until released.
    hold: null as Promise<void> | null,
    entered: () => {},
    reads: 0,
  };
  const provider = {
    id: "boat",
    get: async (sandboxId: string) => ({ id: sandboxId, state: state.stopped ? "stopped" : "ready" }),
    interrupt: async () => {},
    exec: async () => ({ detached: false, exitCode: 0, timedOut: false, truncated: false, stderr: "", stdout: "{}" }),
    readOutputs: async () => {
      state.reads++;
      state.entered();
      if (state.hold) await state.hold;
      return state.stopped ? null : state.live;
    },
  } as unknown as Provider;
  return { state, provider };
}

/** One worker-lane pass plus its background sample (the lane itself never waits for the read). */
async function sample(service: ReturnType<typeof createSandboxOutputs>) {
  const claimed = await service.reconcileOne(signal());
  await service.drain();
  return claimed;
}

const routeFor = (service: ReturnType<typeof createSandboxOutputs>, userId: string, orgId: string) =>
  service.route(async () => ({ ok: true, caller: { userId, via: "service", orgs: [{ orgId, role: "member" }] } }));

test("collected outputs survive stop, deduplicate webhook events and enforce interior authorization", async () => {
  const { db, people, id, sql } = await fixture();
  await db.query(
    `insert into outbound_webhook_endpoints(org_id,url,secret_enc) values($1,'https://receiver.example/events',$2)`,
    [people.org, new Uint8Array([1])],
  );
  const { state, provider } = disks();
  state.live = [file("memo.pdf", "document")];
  const service = createSandboxOutputs(sql, KEY, async () => provider);
  expect(await sample(service)).toBe(true);
  await db.query(`update sandboxes set outputs_checked_at=null where id=$1`, [id]);
  expect(await sample(service)).toBe(true);
  expect(
    (await db.query(`select 1 from outbound_webhook_deliveries where payload->>'type'='sandbox.output.available'`))
      .rows,
  ).toHaveLength(1);
  await db.query(`update sandboxes set status='stopped',stopped_at=now(),outputs_checked_at=null where id=$1`, [id]);
  // A stopped workspace is never read: the last live snapshot is what stays downloadable.
  expect(await sample(service)).toBe(false);
  expect(state.reads).toBe(2);
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs`;
  const response = await routeFor(service, people.owner, people.org)(new Request(`${url}/memo.pdf`));
  expect(response?.status).toBe(200);
  expect(response?.headers.get("content-type")).toBe("application/pdf");
  expect(await response?.text()).toBe("document");
  expect((await routeFor(service, people.member, people.org)(new Request(url)))?.status).toBe(404);
  expect((await routeFor(service, people.owner, crypto.randomUUID())(new Request(url)))?.status).toBe(404);
  // Only a well-formed UUID reaches the uuid-typed query; anything else is not this route.
  const malformed = `https://armada.example/api/v1/sandboxes/${"-".repeat(36)}/outputs`;
  expect(await routeFor(service, people.owner, people.org)(new Request(malformed))).toBeNull();
});

test("stop captures files written after the last sample, for native and enrolled-runtime sandboxes", async () => {
  const { db, people, id, sql } = await fixture({ boatId: "final_native" });
  const enrolled = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,boat_runtime)
    select $1,golden_id,org_id,owner_id,'final_runtime','codex','ready',true from sandboxes where id=$2`,
    [enrolled, id],
  );
  const { state, provider } = disks();
  const previous = process.env.ARMADA_ENCRYPTION_KEY;
  process.env.ARMADA_ENCRYPTION_KEY = KEY;
  try {
    const service = createSandboxOutputs(sql, KEY, async () => provider);
    expect(await sample(service)).toBe(true);
    expect(await sample(service)).toBe(true);
    state.live = [file("final.pdf", "final")];
    await db.query(
      `update sandboxes set status='stopping',stop_requested_at=now(),stop_generation=stop_generation+1 where id = any($1)`,
      [[id, enrolled]],
    );
    await preserveBeforeStop(sql, provider, id, "final_native");
    await preserveBeforeStop(sql, provider, enrolled, "final_runtime");
    for (const sandbox of [id, enrolled]) {
      const url = `https://armada.example/api/v1/sandboxes/${sandbox}/outputs/final.pdf`;
      const download = await routeFor(service, people.owner, people.org)(new Request(url));
      expect(download?.status).toBe(200);
      expect(await download?.text()).toBe("final");
    }
  } finally {
    if (previous === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
    else process.env.ARMADA_ENCRYPTION_KEY = previous;
  }
});

test("application-secret taint forbids output sampling, final capture, late persistence and download", async () => {
  const { db, people, id, sql } = await fixture({ boatId: "tainted_fixture" });
  const { state, provider } = disks();
  state.live = [file("memo.pdf", "secret")];
  const service = createSandboxOutputs(sql, KEY, async () => provider);
  // A snapshot captured before exposure is purged when taint commits.
  expect(await sample(service)).toBe(true);
  expect((await db.query(`select 1 from sandbox_outputs where sandbox_id=$1`, [id])).rows).toHaveLength(1);
  await db.query(`update sandboxes set application_secret_tainted=true,outputs_checked_at=null where id=$1`, [id]);
  expect((await db.query(`select 1 from sandbox_outputs where sandbox_id=$1`, [id])).rows).toHaveLength(0);
  // Neither periodic sampling nor the stop-path final capture reads tainted disks.
  expect(await sample(service)).toBe(false);
  await captureFinalOutputs(sql, provider, id, { key: KEY });
  await db.query(`update sandboxes set status='stopped',stopped_at=now() where id=$1`, [id]);
  expect(await sample(service)).toBe(false);
  expect(state.reads).toBe(1);
  // A collector that started before taint cannot persist afterwards.
  await expect(
    db.query(`insert into sandbox_outputs(sandbox_id,name,digest,size,content_enc) values($1,'late','d',0,'\\x00')`, [
      id,
    ]),
  ).rejects.toThrow("Sandbox outputs unavailable");
  const route = routeFor(service, people.owner, people.org);
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs`;
  expect((await route(new Request(url)))?.status).toBe(404);
  expect((await route(new Request(`${url}/memo.pdf`)))?.status).toBe(404);
});

test("a failed or out-of-bounds read keeps the previous snapshot and never fails the shared worker tick", async () => {
  const { db, id, sql } = await fixture({ boatId: "failing_fixture" });
  const { state, provider } = disks();
  state.live = [file("memo.txt", "draft")];
  const service = createSandboxOutputs(sql, KEY, async () => provider);
  expect(await sample(service)).toBe(true);
  // A provider returning entries the collector cannot produce is refused at server admission.
  state.live = [file("../key", "x"), file("memo.txt", "replaced")];
  await db.query(`update sandboxes set outputs_checked_at=null where id=$1`, [id]);
  expect(await sample(service)).toBe(true);
  expect((await db.query(`select name,size from sandbox_outputs where sandbox_id=$1`, [id])).rows).toEqual([
    { name: "memo.txt", size: 5 },
  ]);
});

test("a hanging provider read yields at the caller deadline, stays tracked and never persists late", async () => {
  const { db, id, sql } = await fixture({ boatId: "hanging_fixture" });
  const { state, provider } = disks();
  state.live = [file("memo.txt", "late")];
  let release = () => {};
  state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = () =>
    new Promise<void>((resolve) => {
      state.entered = resolve;
    });
  const rows = async () => (await db.query(`select 1 from sandbox_outputs where sandbox_id=$1`, [id])).rows;
  const service = createSandboxOutputs(sql, KEY, async () => provider);
  // Worker lane: it returns while the SDK promise is still pending, so the next lane (stop
  // reconciliation, webhooks) runs; the read stays tracked and cannot persist after its deadline.
  const deadline = new AbortController();
  let reading = entered();
  expect(await service.reconcileOne(deadline.signal)).toBe(true);
  await reading;
  deadline.abort();
  release();
  await service.drain();
  expect(await rows()).toHaveLength(0);
  // Stop path: the final capture is bounded the same way, so stop dispatch proceeds.
  state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = new AbortController();
  reading = entered();
  const capture = captureFinalOutputs(sql, provider, id, { key: KEY, signal: stop.signal });
  await reading;
  stop.abort();
  await expect(capture).rejects.toBeDefined();
  release();
  await drainFinalOutputs();
  expect(await rows()).toHaveLength(0);
  expect(state.reads).toBe(2);
});

test("a collection whose deadline passes while it waits for the row lock never commits files or events", async () => {
  const { db, people, id, sql } = await fixture({ boatId: "gated_fixture" });
  await db.query(
    `insert into outbound_webhook_endpoints(org_id,url,secret_enc) values($1,'https://receiver.example/events',$2)`,
    [people.org, new Uint8Array([1])],
  );
  const { state, provider } = disks();
  state.live = [file("final.pdf", "final")];
  // The provider has answered; the row-lock query is then held (a concurrent stop) past the deadline.
  let release = () => {};
  let locking = () => {};
  const gated = (): Sql => {
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      query: sql.query,
      transaction: (work) =>
        sql.transaction!((tx) =>
          work({
            query: async (q, p) => {
              if (q.includes("for update")) {
                locking();
                await held;
              }
              return tx.query(q, p);
            },
          }),
        ),
    };
  };
  const waitForLock = () =>
    new Promise<void>((resolve) => {
      locking = resolve;
    });
  const committed = async () => ({
    files: (await db.query(`select 1 from sandbox_outputs where sandbox_id=$1`, [id])).rows.length,
    events: (
      await db.query(
        `select 1 from outbound_webhook_deliveries where payload->>'type'='sandbox.output.available' and payload->>'sandboxId'=$1`,
        [id],
      )
    ).rows.length,
  });
  // Periodic sample: the lane yields at its deadline; the late transaction rolls back.
  const service = createSandboxOutputs(gated(), KEY, async () => provider);
  const deadline = new AbortController();
  let waiting = waitForLock();
  const lane = service.reconcileOne(deadline.signal);
  await waiting;
  deadline.abort();
  expect(await lane).toBe(true);
  release();
  await service.drain();
  expect(await committed()).toEqual({ files: 0, events: 0 });
  // Final pre-stop capture: the same fence holds at its write boundary.
  const stop = new AbortController();
  waiting = waitForLock();
  const capture = captureFinalOutputs(gated(), provider, id, { key: KEY, signal: stop.signal });
  await waiting;
  stop.abort();
  await expect(capture).rejects.toBeDefined();
  release();
  await drainFinalOutputs();
  expect(await committed()).toEqual({ files: 0, events: 0 });
  // Without a deadline, the same path publishes.
  await captureFinalOutputs(sql, provider, id, { key: KEY });
  expect(await committed()).toEqual({ files: 1, events: 1 });
});

test("concurrent stops within their deadline all take their final capture", async () => {
  const { id, sql } = await fixture({ boatId: "concurrent_fixture" });
  const { state, provider } = disks();
  state.live = [file("memo.txt", "final")];
  let release = () => {};
  state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = (count: number) =>
    new Promise<void>((resolve) => {
      state.entered = () => {
        if (state.reads === count) resolve();
      };
    });
  const capture = () => captureFinalOutputs(sql, provider, id, { key: KEY, signal: new AbortController().signal });
  // Four stops are reading (e.g. a parent stopping its children); none has passed its deadline.
  let entered = reading(4);
  const captures = Array.from({ length: 4 }, capture);
  await entered;
  // A fifth stop is not refused as busy while the others are still within their deadline.
  entered = reading(5);
  captures.push(capture());
  await entered;
  release();
  await Promise.all(captures);
  expect((await sql.query(`select name from sandbox_outputs where sandbox_id=$1`, [id])).rows).toEqual([
    { name: "memo.txt" },
  ]);
});
