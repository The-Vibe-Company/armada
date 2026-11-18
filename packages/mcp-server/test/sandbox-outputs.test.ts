import { expect, test } from "bun:test";
import { OutputCollectionError, type OutputFile, type Provider, type Sql } from "@armada/core/server";
import { captureFinalOutputs, createSandboxOutputs, drainFinalOutputs } from "../src/sandbox-outputs.ts";
import { startServerWorkers } from "../src/server-workers.ts";
import { preserveBeforeStop } from "../src/work-preservation.ts";
import { publishedGetResponse } from "./published-response.ts";
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

/** A stand-in for live reads only. */
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
  let probes = 0;
  const service = createSandboxOutputs(sql, KEY, async () => ({
    readOutputs: provider.readOutputs!,
    openRetainedOutputs: async () => "gone",
    async probeOutputs() {
      probes++;
      return true;
    },
  }));
  expect(await sample(service)).toBe(true);
  await db.query(`update sandboxes set outputs_checked_at=null where id=$1`, [id]);
  expect(await sample(service)).toBe(true);
  expect(probes).toBe(1);
  expect(
    (await db.query(`select 1 from outbound_webhook_deliveries where payload->>'type'='sandbox.output.available'`))
      .rows,
  ).toHaveLength(1);
  await db.query(
    `update sandboxes set status='stopped',stopped_at=now()-interval '15 days',outputs_checked_at=null where id=$1`,
    [id],
  );
  // Boat confirmed the old archive is absent; its live capture stays downloadable.
  expect(await sample(service)).toBe(true);
  expect(state.reads).toBe(2);
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs`;
  const route = routeFor(service, people.owner, people.org);
  expect(await (await route(new Request(url)))?.json()).toMatchObject({ directory: "/home/user/outputs" });
  const response = await route(new Request(`${url}/memo.pdf`));
  expect(response?.status).toBe(200);
  expect(response?.headers.get("content-type")).toBe("application/pdf");
  expect(await response?.text()).toBe("document");
  // The list and a refusal parse with the published OpenAPI contract.
  const list = await routeFor(service, people.owner, people.org)(new Request(url));
  expect(publishedGetResponse("sandboxes/{id}/outputs", "200").parse(await list?.json())).toMatchObject({
    directory: "/home/user/outputs",
    files: [{ name: "memo.pdf", size: 8 }],
  });
  const refused = await routeFor(service, people.member, people.org)(new Request(url));
  expect(refused?.status).toBe(404);
  expect(publishedGetResponse("sandboxes/{id}/outputs", "404").safeParse(await refused?.json()).success).toBe(true);
  expect((await routeFor(service, people.owner, crypto.randomUUID())(new Request(url)))?.status).toBe(404);
  // Only a well-formed UUID reaches the uuid-typed query; anything else is not this route.
  const malformed = `https://armada.example/api/v1/sandboxes/${"-".repeat(36)}/outputs`;
  expect(await routeFor(service, people.owner, people.org)(new Request(malformed))).toBeNull();
});

test.each([
  [
    "interrupted launch",
    "status='failed',stopped_at=now(),transition_context=jsonb_build_object('actor','reconciler','code','launch_interrupted')",
  ],
  ["deleted", "status='deleted',deleted_at=now(),stopped_at=now()"],
  ["starting", "status='starting'"],
])("the worker skips %s sandboxes without contacting the provider", async (label, transition) => {
  const { db, id, sql } = await fixture();
  if (label === "interrupted launch") await db.query("update sandboxes set status='starting' where id=$1", [id]);
  await db.query(`update sandboxes set ${transition} where id=$1`, [id]);
  let resolutions = 0;
  const service = createSandboxOutputs(sql, KEY, async () => {
    resolutions++;
    return {};
  });
  expect(await sample(service)).toBe(false);
  expect(resolutions).toBe(0);
});

test("definitive retained absence is recorded once without a failure", async () => {
  const { db, id, sql } = await fixture();
  await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [id]);
  const logs: unknown[] = [];
  const info = console.info;
  console.info = (line: string) => logs.push(JSON.parse(line));
  try {
    const service = createSandboxOutputs(sql, KEY, async () => ({ openRetainedOutputs: async () => "gone" }));
    expect(await sample(service)).toBe(true);
    await db.query("update sandboxes set outputs_checked_at=null where id=$1", [id]);
    expect(await sample(service)).toBe(false);
    expect(logs).toEqual([
      {
        event: "sandbox_output_collection_empty",
        sandboxId: id,
        reason: "retained_outputs_absent",
        provider: "boat",
        status: "stopped",
        attemptCount: 1,
      },
    ]);
  } finally {
    console.info = info;
  }
});

test("a missing live output directory is reported once and later files remain collectible", async () => {
  const { db, id, sql } = await fixture();
  let files: OutputFile[] | undefined;
  const provider = {
    readOutputs: async () => {
      if (!files) throw new OutputCollectionError("output_directory_missing");
      return files;
    },
  };
  const service = createSandboxOutputs(sql, KEY, async () => provider);
  const logs: unknown[] = [];
  const info = console.info;
  console.info = (line: string) => logs.push(JSON.parse(line));
  try {
    expect(await sample(service)).toBe(true);
    await captureFinalOutputs(sql, provider, id, { key: KEY });
    expect(logs).toEqual([
      {
        event: "sandbox_output_collection_empty",
        sandboxId: id,
        reason: "output_directory_missing",
        provider: "boat",
        status: "ready",
        attemptCount: 1,
      },
    ]);
  } finally {
    console.info = info;
  }
  files = [file("later.txt", "ready")];
  await db.query("update sandboxes set outputs_checked_at=null where id=$1", [id]);
  expect(await sample(service)).toBe(true);
  expect((await db.query("select name from sandbox_outputs where sandbox_id=$1", [id])).rows).toEqual([
    { name: "later.txt" },
  ]);
});

test("a transient retained read backs off, then publishes a file from the stopped workspace once", async () => {
  const { db, people, id, sql } = await fixture();
  await db.query(`update sandboxes set status='stopped',stopped_at=now()-interval '15 days' where id=$1`, [id]);
  const bytes = Buffer.from("written after the final live sample");
  let attempts = 0;
  const service = createSandboxOutputs(sql, KEY, async () => ({
    async openRetainedOutputs() {
      if (++attempts === 1) return null;
      return {
        entries: [{ name: "late.txt", size: bytes.length, revision: "1:2:3:4" }],
        readChunk: () => bytes,
      };
    },
  }));
  expect(await sample(service)).toBe(true);
  expect(await sample(service)).toBe(false);
  await db.query(`update sandboxes set outputs_checked_at=now()-interval '3 minutes' where id=$1`, [id]);
  expect(await sample(service)).toBe(true);
  const route = routeFor(service, people.owner, people.org);
  const response = await route(new Request(`https://armada.example/api/v1/sandboxes/${id}/outputs/late.txt`));
  expect(await response?.text()).toBe(bytes.toString());
  await db.query(`update sandboxes set outputs_checked_at=now()-interval '3 minutes' where id=$1`, [id]);
  expect(await sample(service)).toBe(false);
  expect(attempts).toBe(2);
});

test("a stalled retained read leaves capacity to collect live outputs", async () => {
  const { db, id, sql } = await fixture();
  await db.query(
    `insert into sandboxes(golden_id,org_id,owner_id,boat_id,harness,status,stopped_at)
     select golden_id,org_id,owner_id,'archive_' || n,harness,'stopped',now()
     from sandboxes cross join generate_series(1,2) n where id=$1`,
    [id],
  );
  await db.query("update sandboxes set outputs_checked_at=now()-interval '1 minute' where id=$1", [id]);
  const hold = Promise.withResolvers<null>();
  const entered = Promise.withResolvers<void>();
  const service = createSandboxOutputs(sql, KEY, async () => ({
    openRetainedOutputs() {
      entered.resolve();
      return hold.promise;
    },
    readOutputs: async () => [file("live.txt", "still running")],
  }));
  try {
    expect(await service.reconcileOne(signal())).toBe(true);
    await entered.promise;
    expect(await service.reconcileOne(signal())).toBe(true);
    // With the live row just sampled, only the second retained row remains eligible.
    expect(await service.reconcileOne(signal())).toBe(false);
  } finally {
    hold.resolve(null);
    await service.drain();
  }
  expect((await db.query("select name from sandbox_outputs where sandbox_id=$1", [id])).rows).toEqual([
    { name: "live.txt" },
  ]);
});

test("an unsupported collector is reported once and skipped by both sampling and final capture", async () => {
  const { db, people, id, sql } = await fixture();
  let attempts = 0;
  let reads = 0;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const provider = {
    async probeOutputs() {
      attempts++;
      entered.resolve();
      await release.promise;
      throw new OutputCollectionError("collector_unsupported");
    },
    async readOutputs() {
      reads++;
      throw new OutputCollectionError("collector_unsupported");
    },
  };
  const service = createSandboxOutputs(sql, KEY, async () => provider);
  const lines: unknown[] = [];
  const warn = console.warn;
  console.warn = (line) => lines.push(JSON.parse(line));
  try {
    expect(await service.reconcileOne(signal())).toBe(true);
    await entered.promise;
    // The first sample owns the probe, even when stop claims a separate scan.
    await captureFinalOutputs(sql, provider, id, { key: KEY });
    release.resolve();
    await service.drain();
    await db.query(`update sandboxes set outputs_checked_at=null where id=$1`, [id]);
    expect(await sample(service)).toBe(false);
    await captureFinalOutputs(sql, provider, id, { key: KEY });
  } finally {
    release.resolve();
    await service.drain();
    console.warn = warn;
  }
  expect(attempts).toBe(1);
  expect(reads).toBe(1);
  expect(lines).toEqual([
    {
      event: "sandbox_output_final_capture_failed",
      sandboxId: id,
      reason: "collector_unsupported",
      provider: "boat",
      status: "ready",
      attemptCount: 2,
    },
  ]);
  const route = routeFor(service, people.owner, people.org);
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs`;
  expect(await (await route(new Request(url)))?.json()).toMatchObject({
    unavailable: "collector_unsupported",
    files: [],
  });
});

test("final capture publishes deliverables while the first periodic capability probe is in flight", async () => {
  const { people, id, sql } = await fixture();
  const probeEntered = Promise.withResolvers<void>();
  const probeReleased = Promise.withResolvers<boolean>();
  const provider = {
    async probeOutputs() {
      probeEntered.resolve();
      return probeReleased.promise;
    },
    async readOutputs() {
      return [file("final.txt", "deliverable")];
    },
  };
  const service = createSandboxOutputs(sql, KEY, async () => provider);
  try {
    expect(await service.reconcileOne(signal())).toBe(true);
    await probeEntered.promise;
    await captureFinalOutputs(sql, provider, id, { key: KEY });
    const route = routeFor(service, people.owner, people.org);
    const url = `https://armada.example/api/v1/sandboxes/${id}/outputs/final.txt`;
    expect(await (await route(new Request(url)))?.text()).toBe("deliverable");
  } finally {
    probeReleased.resolve(true);
    await service.drain();
  }
});

test("a stop before the first sample reads even when a capability probe would fail transiently", async () => {
  const { people, id, sql } = await fixture();
  let probes = 0;
  let reads = 0;
  const provider = {
    async probeOutputs(): Promise<boolean> {
      probes++;
      throw new OutputCollectionError("output_timeout");
    },
    async readOutputs() {
      reads++;
      return [file("memo.txt", "last deliverable")];
    },
  };
  const service = createSandboxOutputs(sql, KEY, async () => provider);
  await captureFinalOutputs(sql, provider, id, { key: KEY, signal: signal() });
  expect(probes).toBe(0);
  expect(reads).toBe(1);
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs/memo.txt`;
  expect(await (await routeFor(service, people.owner, people.org)(new Request(url)))?.text()).toBe("last deliverable");
});

test("a final read that finds the collector unsupported records it without retrying", async () => {
  const { db, id, sql } = await fixture();
  let reads = 0;
  const provider = {
    async probeOutputs(): Promise<boolean> {
      throw Error("final capture must not probe");
    },
    async readOutputs(): Promise<OutputFile[]> {
      reads++;
      throw new OutputCollectionError("collector_unsupported");
    },
  };
  await captureFinalOutputs(sql, provider, id, { key: KEY, signal: signal() });
  // Known unavailable: a later stop skips the read entirely, adding no delay.
  await captureFinalOutputs(sql, provider, id, { key: KEY, signal: signal() });
  expect(reads).toBe(1);
  expect((await db.query(`select outputs_failure_reasons from sandboxes where id=$1`, [id])).rows[0]).toEqual({
    outputs_failure_reasons: ["collector_unsupported"],
  });
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

test("taint committed after a sample claimed its row never reaches the provider read", async () => {
  const { db, id, sql } = await fixture({ boatId: "tainted_after_claim" });
  const { state, provider } = disks();
  state.live = [file("memo.pdf", "secret")];
  // Taint commits while the claimed sample resolves its provider.
  const service = createSandboxOutputs(sql, KEY, async () => {
    await db.query(`update sandboxes set application_secret_tainted=true where id=$1`, [id]);
    return provider;
  });
  expect(await sample(service)).toBe(true);
  expect(state.reads).toBe(0);
  expect((await db.query(`select 1 from sandbox_outputs where sandbox_id=$1`, [id])).rows).toHaveLength(0);
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

async function stalledModalFixture() {
  const healthy = await fixture();
  const { db, people } = healthy;
  const golden = (
    await db.query<{ id: string }>(
      `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,
        modal_workspace,modal_environment,modal_app_id,config)
       values($1,$2,'stalled','private','modal','master','image','workspace','main','app','{"repos":[],"init":[]}')
       returning id`,
      [people.org, people.owner],
    )
  ).rows[0]!;
  const stalled = (
    await db.query<{ id: string }>(
      `insert into sandboxes(provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status)
       select 'modal','stalled_' || n,$1,$2,$3,'codex','ready' from generate_series(1,5) n returning id`,
      [golden.id, people.org, people.owner],
    )
  ).rows.map(({ id }) => id);
  const { state, provider } = disks();
  state.live = [file("memo.txt", "healthy")];
  const names = async () => (await db.query("select sandbox_id,name from sandbox_outputs")).rows;
  return { ...healthy, stalled, provider, names };
}

test("expired Modal lookups leave sampling capacity for a healthy Boat sandbox", async () => {
  const { db, id, sql, stalled, provider, names } = await stalledModalFixture();
  // Make the healthy sandbox the oldest previously sampled row, behind all unsampled Modal rows.
  await db.query("update sandboxes set outputs_checked_at=now()-interval '1 minute' where id=$1", [id]);
  const hold = Promise.withResolvers<typeof provider>();
  let lookups = 0;
  const service = createSandboxOutputs(sql, KEY, async (sandboxId) => {
    if (sandboxId === id) return provider;
    lookups++;
    return hold.promise;
  });
  try {
    for (const _ of stalled.slice(0, 4)) {
      const deadline = new AbortController();
      expect(await service.reconcileOne(deadline.signal)).toBe(true);
      deadline.abort();
    }
    expect(lookups).toBe(4);
    expect(await sample(service)).toBe(true);
    expect(await names()).toEqual([{ sandbox_id: id, name: "memo.txt" }]);
    expect(lookups).toBe(4);
  } finally {
    hold.resolve(provider);
    await service.drain();
  }
});

test("expired Modal reads leave final capture capacity for a healthy Boat sandbox", async () => {
  const { id, sql, stalled, provider, names } = await stalledModalFixture();
  const modal = disks();
  modal.state.live = [file("late.txt", "expired")];
  const hold = Promise.withResolvers<void>();
  modal.state.hold = hold.promise;
  try {
    for (const sandboxId of stalled.slice(0, 4)) {
      const reading = Promise.withResolvers<void>();
      modal.state.entered = reading.resolve;
      const deadline = new AbortController();
      const capture = captureFinalOutputs(sql, modal.provider, sandboxId, { key: KEY, signal: deadline.signal });
      await reading.promise;
      deadline.abort();
      await expect(capture).rejects.toBe(deadline.signal.reason);
    }
    await expect(captureFinalOutputs(sql, provider, stalled[4]!, { key: KEY })).rejects.toMatchObject({
      reason: "output_busy",
    });
    await captureFinalOutputs(sql, provider, id, { key: KEY });
    expect(await names()).toEqual([{ sandbox_id: id, name: "memo.txt" }]);
  } finally {
    hold.resolve();
    await drainFinalOutputs();
  }
  expect(await names()).toEqual([{ sandbox_id: id, name: "memo.txt" }]);
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

test("a final capture whose deadline passes while its scan claim waits never holds stop or reads", async () => {
  const { id, sql } = await fixture({ boatId: "claim_fixture" });
  const { state, provider } = disks();
  state.live = [file("memo.txt", "late")];
  // The first query (the scan claim) is held, like a contended row lock or a stalled pool connection.
  let release = () => {};
  let claiming = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    claiming = resolve;
  });
  const gated: Sql = {
    ...sql,
    query: async (q, p) => {
      if (q.includes("outputs_checked_at=clock_timestamp()")) {
        claiming();
        await held;
      }
      return sql.query(q, p);
    },
  };
  const stop = new AbortController();
  const capture = captureFinalOutputs(gated, provider, id, { key: KEY, signal: stop.signal });
  await waiting;
  stop.abort();
  await expect(capture).rejects.toBeDefined();
  release();
  await drainFinalOutputs();
  expect(state.reads).toBe(0);
  expect((await sql.query(`select 1 from sandbox_outputs where sandbox_id=$1`, [id])).rows).toHaveLength(0);
});

test("a user stop of a failed sandbox whose compute still runs captures its final bytes", async () => {
  const { db, people, id, sql } = await fixture({ boatId: "failed_fixture" });
  const { state, provider } = disks();
  state.live = [file("memo.txt", "draft")];
  const previous = process.env.ARMADA_ENCRYPTION_KEY;
  process.env.ARMADA_ENCRYPTION_KEY = KEY;
  try {
    const service = createSandboxOutputs(sql, KEY, async () => provider);
    expect(await sample(service)).toBe(true);
    state.live = [file("memo.txt", "final")];
    // The user-stop path keeps the logical 'failed' status while it admits the stop.
    await db.query(
      `update sandboxes set status='failed',stop_requested_at=now(),stop_generation=stop_generation+1 where id=$1`,
      [id],
    );
    await preserveBeforeStop(sql, provider, id, "failed_fixture", "user_stop");
    const url = `https://armada.example/api/v1/sandboxes/${id}/outputs/memo.txt`;
    const download = await routeFor(service, people.owner, people.org)(new Request(url));
    expect(await download?.text()).toBe("final");
  } finally {
    if (previous === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
    else process.env.ARMADA_ENCRYPTION_KEY = previous;
  }
});

test("an in-flight sample publishes unless a newer final capture commits first", async () => {
  const { people, id, sql } = await fixture({ boatId: "sample_vs_final" });
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs/memo.txt`;
  const read = async (service: ReturnType<typeof createSandboxOutputs>) =>
    (await routeFor(service, people.owner, people.org)(new Request(url)))?.text();
  // The periodic sample is claimed and its provider read hangs.
  const periodic = disks();
  let release = () => {};
  periodic.state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    periodic.state.entered = resolve;
  });
  const service = createSandboxOutputs(sql, KEY, async () => periodic.provider);
  expect(await service.reconcileOne(signal())).toBe(true);
  await entered;
  // The newer pre-stop capture reads the final bytes and commits first.
  const final = disks();
  final.state.live = [file("memo.txt", "final")];
  await captureFinalOutputs(sql, final.provider, id, { key: KEY, signal: signal() });
  expect(await read(service)).toBe("final");
  // The older sample answers late with what it saw: it never goes back over the newer snapshot.
  periodic.state.live = [file("memo.txt", "draft")];
  release();
  await service.drain();
  expect(periodic.state.reads).toBe(1);
  expect(await read(service)).toBe("final");
});

test("an in-flight sample still publishes when the newer final capture fails", async () => {
  const { people, id, sql } = await fixture({ boatId: "sample_after_failed_final" });
  const periodic = disks();
  let release = () => {};
  periodic.state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    periodic.state.entered = resolve;
  });
  const service = createSandboxOutputs(sql, KEY, async () => periodic.provider);
  expect(await service.reconcileOne(signal())).toBe(true);
  await entered;
  // The newer pre-stop capture claims a later scan but its read fails.
  const final = disks();
  final.state.stopped = true;
  await expect(captureFinalOutputs(sql, final.provider, id, { key: KEY, signal: signal() })).rejects.toThrow(
    "output_unavailable",
  );
  periodic.state.live = [file("memo.txt", "draft")];
  release();
  await service.drain();
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs/memo.txt`;
  const response = await routeFor(service, people.owner, people.org)(new Request(url));
  expect(response?.status).toBe(200);
  expect(await response?.text()).toBe("draft");
});

test("access revoked while a snapshot is read never receives its metadata or bytes", async () => {
  const { db, people, id, sql } = await fixture({ boatId: "revoked_fixture" });
  const { state, provider } = disks();
  state.live = [file("memo.pdf", "document")];
  expect(await sample(createSandboxOutputs(sql, KEY, async () => provider))).toBe(true);
  // Membership ends between the entry check and the response (after the snapshot query).
  let revoke = false;
  const revoking: Sql = {
    query: async (q, p) => {
      const result = await db.query(q, p);
      if (revoke && q.includes("from public.sandbox_outputs"))
        await db.query(`delete from members where org_id=$1 and user_id=$2`, [people.org, people.owner]);
      return result as never;
    },
  };
  const route = routeFor(
    createSandboxOutputs(revoking, KEY, async () => provider),
    people.owner,
    people.org,
  );
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs`;
  expect((await route(new Request(`${url}/memo.pdf`)))?.status).toBe(200);
  revoke = true;
  expect((await route(new Request(`${url}/memo.pdf`)))?.status).toBe(404);
  await db.query(`insert into members(org_id,user_id,role) values($1,$2,'member')`, [people.org, people.owner]);
  expect((await route(new Request(url)))?.status).toBe(404);
});

test("worker shutdown finishes while a cancelled sample's provider read is still unresolved", async () => {
  const { db, id, sql } = await fixture({ boatId: "stalled_fixture" });
  const { state, provider } = disks();
  state.live = [file("memo.txt", "late")];
  let release = () => {};
  state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    state.entered = resolve;
  });
  const idle = { reconcileOne: async () => false, drain: async () => {} };
  const workers = startServerWorkers(
    { runOne: async () => false, reconcileOne: async () => 0 } as never,
    idle,
    () => {},
    undefined,
    undefined,
    [createSandboxOutputs(sql, KEY, async () => provider)],
  );
  await reading;
  workers.stop();
  // Resolves although the provider promise is still pending: the cancelled read is fenced.
  await workers.done;
  // Once the provider finally answers, the background sample settles without persisting.
  const warn = console.warn;
  const settled = new Promise<void>((resolve) => {
    console.warn = (line: string) => {
      if (line.includes("sandbox_output_collection_failed") && line.includes(id)) resolve();
    };
  });
  try {
    release();
    await settled;
  } finally {
    console.warn = warn;
  }
  expect((await db.query(`select 1 from sandbox_outputs where sandbox_id=$1`, [id])).rows).toHaveLength(0);
  expect(state.reads).toBe(1);
});

test("a failed chunk read resumes from durable progress and publishes a ranged download", async () => {
  const { db, people, id, sql } = await fixture();
  const bytes = Buffer.alloc(65538, 7);
  Buffer.from("abcd").copy(bytes, 32766);
  const entries = [
    { name: "document.pdf", size: bytes.length, revision: "1:2:3:4" },
    { name: "oversized.zip", size: 33554433, revision: "1:3:3:4" },
  ];
  const offsets: number[] = [];
  let interrupted = false;
  const reader = {
    listOutputEntries: async () => entries,
    readOutputChunk: async ({ chunk }: Parameters<NonNullable<Provider["readOutputChunk"]>>[0]) => {
      expect(chunk.entry.name).toBe("document.pdf");
      offsets.push(chunk.offset);
      if (chunk.offset === 32768 && !interrupted) {
        interrupted = true;
        return null;
      }
      return bytes.subarray(chunk.offset, chunk.offset + 32768);
    },
  };
  const service = createSandboxOutputs(sql, KEY, async () => reader);
  const route = routeFor(service, people.owner, people.org);
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs`;
  await expect(captureFinalOutputs(sql, reader, id, { key: KEY })).rejects.toThrow("output_unavailable");
  expect((await route(new Request(`${url}/document.pdf`)))?.status).toBe(404);
  await captureFinalOutputs(sql, reader, id, { key: KEY });
  expect(offsets).toEqual([0, 32768, 32768, 65536]);
  const list = await (await route(new Request(url)))?.json();
  expect(publishedGetResponse("sandboxes/{id}/outputs", "200").parse(list)).toMatchObject({
    files: [
      { name: "document.pdf", size: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") },
      { name: "oversized.zip", size: 33554433, skipped: "too_large", sha256: null },
    ],
    limits: { maxFileBytes: 33554432 },
  });
  expect((await route(new Request(`${url}/oversized.zip`)))?.status).toBe(404);
  const response = await route(new Request(`${url}/document.pdf`, { headers: { range: "bytes=32766-32769" } }));
  expect(response?.status).toBe(206);
  expect(response?.headers.get("content-range")).toBe("bytes 32766-32769/65538");
  expect(await response?.text()).toBe("abcd");
  await db.query("update sandboxes set application_secret_tainted=true where id=$1", [id]);
  expect((await route(new Request(`${url}/document.pdf`)))?.status).toBe(404);
  expect((await db.query("select 1 from sandbox_output_chunks")).rows).toHaveLength(0);
});

test("other sandboxes' in-progress reservations count toward the organization limit", async () => {
  const { db, people, id, sql } = await fixture();
  await db.query(
    `with occupied as (
        insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status)
        select gen_random_uuid(),golden_id,org_id,owner_id,'quota_fixture_' || n,harness,'ready'
        from sandboxes cross join generate_series(1,16) n where id=$1 returning id
      )
      insert into sandbox_output_transfers(sandbox_id,name,revision,size,scan)
      select id, 'reserved-' || n, '1:2:3:4', 33554432, now()
      from occupied cross join generate_series(1,2) n`,
    [id],
  );
  let revision = "1:2:3:4";
  const reader = {
    listOutputEntries: async () => [{ name: "report.pdf", size: 1, revision }],
    readOutputChunk: async () => new Uint8Array([revision === "1:2:3:4" ? 97 : 98]),
  };
  await captureFinalOutputs(sql, reader, id, { key: KEY });
  const service = createSandboxOutputs(sql, KEY, async () => reader);
  const route = routeFor(service, people.owner, people.org);
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs`;
  const list = await route(new Request(url));
  expect(await list?.json()).toMatchObject({ files: [{ name: "report.pdf", size: 1, skipped: "org_limit" }] });

  await db.query(
    `update sandbox_output_transfers set progress_at=now()-interval '16 minutes'
      where id=(select id from sandbox_output_transfers order by id limit 1)`,
  );
  await captureFinalOutputs(sql, reader, id, { key: KEY });
  expect(await (await route(new Request(url + "/report.pdf")))?.text()).toBe("a");

  await db.query(
    `insert into sandbox_output_transfers(sandbox_id,name,revision,size,scan)
      select t.sandbox_id, 'remaining', '1:2:3:4', 33554431, now()
      from sandbox_output_transfers t group by t.sandbox_id having count(*)=1 and min(t.size)=33554432 limit 1`,
  );
  revision = "1:2:3:5";
  await captureFinalOutputs(sql, reader, id, { key: KEY });
  expect(await (await route(new Request(url + "/report.pdf")))?.text()).toBe("a");
});

test("a member stopping the sandbox discards its incomplete output transfers", async () => {
  const { db, people, id } = await fixture();
  await db.query(
    `insert into sandbox_output_transfers(sandbox_id,name,revision,size,scan) values($1,'partial.pdf','1:2:3:4',65536,now())`,
    [id],
  );
  await db.exec("begin");
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [people.owner]);
  await db.exec("set local role authenticated");
  await db.query(`update sandboxes set status='stopped',stopped_at=now() where id=$1`, [id]);
  await db.exec("commit");
  expect((await db.query(`select 1 from sandbox_output_transfers where sandbox_id=$1`, [id])).rows).toHaveLength(0);
});

test("a failed Modal manifest read logs its phase even after the sandbox recorded collector_failed", async () => {
  const id = "modal_output_fixture";
  const warnings: unknown[] = [];
  const reasons: unknown[] = [];
  let claimedId = id;
  const warn = console.warn;
  console.warn = (line: string) => warnings.push(JSON.parse(line));
  const sql: Sql = {
    query: async <T>(query: string, params?: readonly unknown[]) => {
      // The historical reason was claimed on an earlier server version.
      if (query.includes("set outputs_failure_reasons=array_append")) reasons.push(params?.[1]);
      const rows = query.includes("outputs_attempt_count=outputs_attempt_count+1")
        ? [{ id: claimedId, provider: "modal", provider_sandbox_id: "modal_fixture", retained_generation: null }]
        : query.startsWith("select outputs_collector_supported")
          ? [{ outputs_collector_supported: true }]
          : [];
      return { rows: rows as T[] };
    },
    transaction: async () => {
      throw Error("manifest failure must precede writes");
    },
  };
  try {
    const service = createSandboxOutputs(sql, KEY, async () => ({
      listOutputEntries: async () => JSON.parse("private collector output"),
      readOutputChunk: async () => null,
    }));
    expect(await sample(service)).toBe(true);
    claimedId = "other_modal_output_fixture";
    expect(await sample(service)).toBe(true);
    expect(reasons).toEqual(["collector_failed", "collector_failed"]);
    expect(warnings).toEqual([
      {
        event: "sandbox_output_collector_diagnostic",
        sandboxId: id,
        provider: "modal",
        path: "live",
        phase: "list_entries",
        errorKind: "syntax_error",
      },
    ]);
  } finally {
    console.warn = warn;
  }
});
