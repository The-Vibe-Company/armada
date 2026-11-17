import { expect, test } from "bun:test";
import type { OutputFile, Provider, Sql } from "@armada/core/server";
import { captureFinalOutputs, createSandboxOutputs } from "../src/sandbox-outputs.ts";
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

/** A provider stand-in: a live disk while running, the retained disk once stopped. */
function disks() {
  const state = { live: [] as OutputFile[], retained: null as OutputFile[] | null, stopped: false, reads: 0 };
  const provider = {
    id: "boat",
    get: async (sandboxId: string) => ({ id: sandboxId, state: state.stopped ? "stopped" : "ready" }),
    interrupt: async () => {},
    exec: async () => ({ detached: false, exitCode: 0, timedOut: false, truncated: false, stderr: "", stdout: "{}" }),
    readOutputs: async () => {
      state.reads++;
      if (!state.stopped) return { files: state.live, retained: false };
      return state.retained ? { files: state.retained, retained: true } : null;
    },
  } as unknown as Provider;
  return { state, provider };
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
  expect(await service.reconcileOne(signal())).toBe(true);
  await db.query(`update sandboxes set outputs_checked_at=null where id=$1`, [id]);
  expect(await service.reconcileOne(signal())).toBe(true);
  expect(
    (await db.query(`select 1 from outbound_webhook_deliveries where payload->>'type'='sandbox.output.available'`))
      .rows,
  ).toHaveLength(1);
  await db.query(`update sandboxes set status='stopped',stopped_at=now() where id=$1`, [id]);
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs`;
  const response = await routeFor(service, people.owner, people.org)(new Request(`${url}/memo.pdf`));
  expect(response?.status).toBe(200);
  expect(response?.headers.get("content-type")).toBe("application/pdf");
  expect(await response?.text()).toBe("document");
  expect((await routeFor(service, people.member, people.org)(new Request(url)))?.status).toBe(404);
  expect((await routeFor(service, people.owner, crypto.randomUUID())(new Request(url)))?.status).toBe(404);
});

test("a stop without the pre-stop hook publishes the retained disk's files written or changed after the last sample", async () => {
  const { db, people, id, sql } = await fixture();
  const { state, provider } = disks();
  state.live = [file("memo.txt", "draft")];
  const service = createSandboxOutputs(sql, KEY, async () => provider);
  // The last periodic sample sees the draft only.
  expect(await service.reconcileOne(signal())).toBe(true);
  // The agent finishes the memo and writes final.pdf; the provider then stops on its own (TTL),
  // retaining the disk. No Armada pre-stop hook runs.
  state.retained = [file("final.pdf", "final"), file("memo.txt", "final tender")];
  state.stopped = true;
  await db.query(`update sandboxes set status='stopped',stopped_at=now() where id=$1`, [id]);
  expect(await service.reconcileOne(signal())).toBe(true);
  const route = routeFor(service, people.owner, people.org);
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs`;
  const listed = (await (await route(new Request(url)))?.json()) as { files: { name: string }[] };
  expect(listed.files.map((f) => f.name)).toEqual(["final.pdf", "memo.txt"]);
  expect(await (await route(new Request(`${url}/final.pdf`)))?.text()).toBe("final");
  expect(await (await route(new Request(`${url}/memo.txt`)))?.text()).toBe("final tender");
  // The retained disk is read once per stop, not polled.
  await db.query(`update sandboxes set outputs_checked_at=null where id=$1`, [id]);
  expect(await service.reconcileOne(signal())).toBe(false);
  expect(state.reads).toBe(2);
});

test("an unreadable retained disk keeps the pre-stop snapshot and is not polled again for that stop", async () => {
  const { db, people, id, sql } = await fixture();
  const { state, provider } = disks();
  state.live = [file("memo.txt", "captured")];
  const service = createSandboxOutputs(sql, KEY, async () => provider);
  expect(await service.reconcileOne(signal())).toBe(true);
  state.stopped = true; // retained stays null: e.g. a Modal recovery image needs compute to read
  await db.query(`update sandboxes set status='stopped',stopped_at=now() where id=$1`, [id]);
  expect(await service.reconcileOne(signal())).toBe(true);
  await db.query(`update sandboxes set outputs_checked_at=null where id=$1`, [id]);
  expect(await service.reconcileOne(signal())).toBe(false);
  expect(state.reads).toBe(2);
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs/memo.txt`;
  expect(await (await routeFor(service, people.owner, people.org)(new Request(url)))?.text()).toBe("captured");
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
    expect(await service.reconcileOne(signal())).toBe(true);
    expect(await service.reconcileOne(signal())).toBe(true);
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
  expect(await service.reconcileOne(signal())).toBe(true);
  expect((await db.query(`select 1 from sandbox_outputs where sandbox_id=$1`, [id])).rows).toHaveLength(1);
  await db.query(`update sandboxes set application_secret_tainted=true,outputs_checked_at=null where id=$1`, [id]);
  expect((await db.query(`select 1 from sandbox_outputs where sandbox_id=$1`, [id])).rows).toHaveLength(0);
  // Neither periodic sampling, the retained read nor the stop-path final capture reads tainted disks.
  expect(await service.reconcileOne(signal())).toBe(false);
  await captureFinalOutputs(sql, provider, id, { key: KEY });
  await db.query(`update sandboxes set status='stopped',stopped_at=now() where id=$1`, [id]);
  expect(await service.reconcileOne(signal())).toBe(false);
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
  expect(await service.reconcileOne(signal())).toBe(true);
  // A provider returning entries the collector cannot produce is refused at server admission.
  state.live = [file("../key", "x"), file("memo.txt", "replaced")];
  await db.query(`update sandboxes set outputs_checked_at=null where id=$1`, [id]);
  expect(await service.reconcileOne(signal())).toBe(true);
  expect((await db.query(`select name,size from sandbox_outputs where sandbox_id=$1`, [id])).rows).toEqual([
    { name: "memo.txt", size: 5 },
  ]);
});
