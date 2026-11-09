import { expect, test } from "bun:test";
import { createBoatProvider } from "@armada/provider-boat";
import { sandbox } from "../../provider-boat/test/support.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { startServerWorkers } from "../src/server-workers.ts";
import { bunLikeSql, database } from "./support.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function rows() {
  const { db, people } = await database();
  const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
  if (!golden) throw Error("missing golden");
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (const [index, id] of ids.entries())
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,reconcile_after)
    values($1,$2,$3,$4,'boat',$5,'claude','running',now()-($6::integer * interval '1 minute'))`,
      [id, golden.id, people.org, people.owner, `bx_worker_${index}`, 2 - index],
    );
  return { db, sql: bunLikeSql(db), ids };
}

test("server lifecycle drains multiple rows while a golden build is pending; stop tracks both lanes", async () => {
  const { db, sql, ids } = await rows();
  const build = deferred<boolean>();
  const retirement = deferred<boolean>();
  let retirementSignal: AbortSignal | undefined;
  const progress = deferred<void>();
  let buildRunning = false;
  let reconciled = 0;
  const provider = createBoatProvider({
    apiKey: "test-key",
    fetch: (async (_input: Request | string | URL, _init?: RequestInit) =>
      Response.json({ ok: true, sandbox: sandbox({ state: "archived" }) })) as typeof fetch,
  });
  const lifecycle = createSandboxLifecycle(sql, async () => provider);
  const workers = startServerWorkers(
    {
      runOne: async () => {
        buildRunning = true;
        return build.promise;
      },
      reconcileOne: async () => {},
    },
    {
      drain: () => lifecycle.drain(),
      reconcileOne: async (signal) => {
        const result = await lifecycle.reconcileOne(signal);
        if (++reconciled === 2) progress.resolve();
        return result;
      },
    },
    () => {},
    {
      runOne: async (signal) => {
        retirementSignal = signal;
        return retirement.promise;
      },
    },
  );
  try {
    await progress.promise;
    expect(retirementSignal).toBeDefined();
    expect(buildRunning).toBe(true);
    const records = await db.query<{ status: string }>("select status from sandboxes where id=any($1::uuid[])", [ids]);
    expect(records.rows.map((row) => row.status)).toEqual(["stopped", "stopped"]);
    workers.stop();
    let done = false;
    workers.done.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    build.resolve(true);
    await workers.goldenWorker.done;
    expect(retirementSignal?.aborted).toBe(true);
    expect(done).toBe(false);
    retirement.resolve(false);
    await workers.done;
    expect(done).toBe(true);
    const count = reconciled;
    await Promise.resolve();
    expect(reconciled).toBe(count);
  } finally {
    workers.stop();
    build.resolve(false);
    retirement.resolve(false);
    await workers.done;
    await db.close();
  }
});

test("cancelled SDK observation stays tracked but cannot starve the next item or publish late", async () => {
  const { db, sql, ids } = await rows();
  const response = deferred<Response>();
  const entered = deferred<void>();
  let requests = 0;
  const provider = createBoatProvider({
    apiKey: "test-key",
    fetch: (async (_input: Request | string | URL, _init?: RequestInit) => {
      if (++requests === 1) {
        entered.resolve();
        return response.promise;
      }
      return Response.json({ ok: true, sandbox: sandbox({ state: "archived" }) });
    }) as typeof fetch,
  });
  const lifecycle = createSandboxLifecycle(sql, async () => provider);
  const cancellation = new AbortController();
  try {
    const first = lifecycle.reconcileOne(cancellation.signal);
    await entered.promise;
    cancellation.abort();
    await first;
    expect(await lifecycle.reconcileOne()).toBe(true);
    const read = async (id: string) =>
      (
        await db.query<{ status: string; reconcile_lease: string | null; lifecycle_error: string | null }>(
          "select status,reconcile_lease,lifecycle_error from sandboxes where id=$1",
          [id],
        )
      ).rows[0];
    expect((await read(ids[0]!))?.status).toBe("running");
    expect((await read(ids[0]!))?.reconcile_lease).not.toBeNull();
    expect((await read(ids[0]!))?.lifecycle_error).toContain("Retrying");
    expect((await read(ids[1]!))?.status).toBe("stopped");
    let drained = false;
    const done = lifecycle.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    response.resolve(Response.json({ ok: true, sandbox: sandbox({ state: "archived" }) }));
    await done;
    expect((await read(ids[0]!))?.status).toBe("running");
    expect(requests).toBe(2);
  } finally {
    response.resolve(Response.json({ ok: true, sandbox: sandbox({ state: "archived" }) }));
    await lifecycle.drain();
    await db.close();
  }
});

test("retention maintenance runs independently and shutdown tracks an in-flight cleanup", async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const workers = startServerWorkers(
    { runOne: async () => false, reconcileOne: async () => {} },
    { reconcileOne: async () => false, drain: async () => {} },
    () => {},
    undefined,
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  try {
    await entered.promise;
    workers.stop();
    let done = false;
    workers.done.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    release.resolve();
    await workers.done;
    expect(done).toBe(true);
  } finally {
    release.resolve();
    workers.stop();
    await workers.done;
  }
});

test("managed reconciliation shares the existing lane fairly and shutdown drains every admitted SDK operation", async () => {
  const seen: string[] = [];
  const progressed = deferred<void>();
  const retained = deferred<void>();
  let stop = () => {};
  const lane = (name: string, drain: () => Promise<void>) => ({
    async reconcileOne() {
      seen.push(name);
      if (seen.length === 3) {
        stop();
        progressed.resolve();
      }
      return true;
    },
    drain,
  });
  const workers = startServerWorkers(
    {
      async runOne() {
        return false;
      },
      async reconcileOne() {},
    },
    lane("ordinary", async () => {}),
    () => {},
    undefined,
    undefined,
    [lane("parent", async () => {}), lane("child-receipt", () => retained.promise)],
  );
  stop = () => workers.stop();
  try {
    await progressed.promise;
    expect(seen).toEqual(["ordinary", "parent", "child-receipt"]);
    let done = false;
    workers.done.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    retained.resolve();
    await workers.done;
    expect(done).toBe(true);
  } finally {
    workers.stop();
    retained.resolve();
    await workers.done;
  }
});
