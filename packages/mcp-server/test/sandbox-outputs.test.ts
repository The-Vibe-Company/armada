import { expect, test } from "bun:test";
import { parseOutputs } from "../src/sandbox-outputs.ts";

test("output admission bounds decoded bytes and refuses traversal, duplicates and malformed entries", () => {
  const valid = JSON.stringify([{ name: "memo.pdf", base64: Buffer.from("document").toString("base64") }]);
  expect(parseOutputs(valid)[0]?.bytes.toString()).toBe("document");
  for (const name of ["../key", "/key", "a/b", "a\\b", "..", "a\n"]) {
    expect(() => parseOutputs(JSON.stringify([{ name, base64: "" }]))).toThrow();
  }
  for (const entries of [
    [{ name: "memo", base64: "!" }],
    [
      { name: "memo", base64: "" },
      { name: "memo", base64: "" },
    ],
    [{ name: "memo", base64: Buffer.alloc(32769).toString("base64") }],
    Array.from({ length: 5 }, (_, i) => ({ name: String(i), base64: Buffer.alloc(32768).toString("base64") })),
    Array.from({ length: 33 }, (_, i) => ({ name: String(i), base64: "" })),
  ])
    expect(() => parseOutputs(JSON.stringify(entries))).toThrow();
});

import type { Provider, Sql } from "@armada/core/server";
import { createSandboxOutputs } from "../src/sandbox-outputs.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";

const database = rowOnlyDatabase();
test("collected outputs survive stop, deduplicate webhook events and enforce interior authorization", async () => {
  const { db, people } = await database();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status)
    select $1,id,org_id,owner_id,'output_fixture','codex','ready' from goldens
    where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner],
  );
  await db.query(
    `insert into outbound_webhook_endpoints(org_id,url,secret_enc) values($1,'https://receiver.example/events',$2)`,
    [people.org, new Uint8Array([1])],
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
  let calls = 0;
  const service = createSandboxOutputs(
    sql,
    Buffer.alloc(32, 7).toString("base64"),
    async () =>
      ({
        exec: async () => {
          calls++;
          return {
            detached: false,
            exitCode: 0,
            timedOut: false,
            truncated: false,
            stderr: "",
            stdout: JSON.stringify([{ name: "memo.pdf", base64: Buffer.from("document").toString("base64") }]),
          };
        },
      }) as unknown as Provider,
  );
  expect(await service.reconcileOne(new AbortController().signal)).toBe(true);
  await db.query(`update sandboxes set outputs_checked_at=null where id=$1`, [id]);
  expect(await service.reconcileOne(new AbortController().signal)).toBe(true);
  expect(
    (
      await db.query(
        `select payload from outbound_webhook_deliveries where payload->>'type'='sandbox.output.available'`,
      )
    ).rows,
  ).toHaveLength(1);
  await db.query(`update sandboxes set status='stopped',stopped_at=now() where id=$1`, [id]);
  const route = (userId: string, orgId = people.org) =>
    service.route(async () => ({ ok: true, caller: { userId, via: "service", orgs: [{ orgId, role: "member" }] } }));
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs`;
  const response = await route(people.owner)(new Request(`${url}/memo.pdf`));
  expect(response?.status).toBe(200);
  expect(response?.headers.get("content-type")).toBe("application/pdf");
  expect(await response?.text()).toBe("document");
  expect((await route(people.member)(new Request(url)))?.status).toBe(404);
  expect((await route(people.owner, crypto.randomUUID())(new Request(url)))?.status).toBe(404);
  expect(await service.reconcileOne(new AbortController().signal)).toBe(false);
  expect(calls).toBe(2);
});

import { OUTPUT_COLLECTOR } from "../src/sandbox-outputs.ts";
import { preserveBeforeStop } from "../src/work-preservation.ts";

test("stop captures files written after the last sample; enrolled runtimes are never collected", async () => {
  const { db, people } = await database();
  const insert = async (runtime: boolean) => {
    const id = crypto.randomUUID();
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,boat_runtime)
      select $1,id,org_id,owner_id,$2,'codex','ready',$3 from goldens
      where owner_id=$4 and visibility='private' limit 1`,
      [id, `final_${runtime}`, runtime, people.owner],
    );
    return id;
  };
  const id = await insert(false);
  const enrolled = await insert(true);
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
  let files: { name: string; base64: string }[] = [];
  const collected: string[] = [];
  const provider = {
    id: "boat",
    get: async (sandboxId: string) => ({ id: sandboxId, state: "ready" }),
    interrupt: async () => {},
    exec: async (request: { sandboxId: string; command: string }) => {
      if (request.command === OUTPUT_COLLECTOR) collected.push(request.sandboxId);
      return {
        detached: false,
        exitCode: 0,
        timedOut: false,
        truncated: false,
        stderr: "",
        stdout: request.command === OUTPUT_COLLECTOR ? JSON.stringify(files) : '{"status":"clean"}',
      };
    },
  } as unknown as Provider;
  const key = Buffer.alloc(32, 7).toString("base64");
  const previous = process.env.ARMADA_ENCRYPTION_KEY;
  process.env.ARMADA_ENCRYPTION_KEY = key;
  try {
    const service = createSandboxOutputs(sql, key, async () => provider);
    // The last periodic sample sees an empty directory; the agent then writes its deliverable.
    expect(await service.reconcileOne(new AbortController().signal)).toBe(true);
    expect(await service.reconcileOne(new AbortController().signal)).toBe(false);
    expect(collected).toEqual(["final_false"]);
    files = [{ name: "final.pdf", base64: Buffer.from("final").toString("base64") }];
    await db.query(
      `update sandboxes set status='stopping',stop_requested_at=now(),stop_generation=stop_generation+1 where id = any($1)`,
      [[id, enrolled]],
    );
    await preserveBeforeStop(sql, provider, id, "final_false");
    await preserveBeforeStop(sql, provider, enrolled, "final_true");
    expect(collected).toEqual(["final_false", "final_false"]);
    await db.query(`update sandboxes set status='stopped',stopped_at=now(),stop_requested_at=null where id=$1`, [id]);
    const route = service.route(async () => ({
      ok: true,
      caller: { userId: people.owner, via: "service", orgs: [{ orgId: people.org, role: "member" }] },
    }));
    const url = `https://armada.example/api/v1/sandboxes/${id}/outputs`;
    const listed = (await (await route(new Request(url)))?.json()) as { files: { name: string }[] };
    expect(listed.files.map((file) => file.name)).toEqual(["final.pdf"]);
    const download = await route(new Request(`${url}/final.pdf`));
    expect(download?.status).toBe(200);
    expect(await download?.text()).toBe("final");
  } finally {
    if (previous === undefined) delete process.env.ARMADA_ENCRYPTION_KEY;
    else process.env.ARMADA_ENCRYPTION_KEY = previous;
  }
});

import { captureFinalOutputs } from "../src/sandbox-outputs.ts";

test("application-secret taint forbids output sampling, final capture, late persistence and download", async () => {
  const { db, people } = await database();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status)
    select $1,id,org_id,owner_id,'tainted_fixture','codex','ready' from goldens
    where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner],
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
  let calls = 0;
  const provider = {
    exec: async () => {
      calls++;
      return {
        detached: false,
        exitCode: 0,
        timedOut: false,
        truncated: false,
        stderr: "",
        stdout: JSON.stringify([{ name: "memo.pdf", base64: Buffer.from("secret").toString("base64") }]),
      };
    },
  } as unknown as Provider;
  const key = Buffer.alloc(32, 7).toString("base64");
  const service = createSandboxOutputs(sql, key, async () => provider);
  // A snapshot captured before exposure is purged when taint commits.
  expect(await service.reconcileOne(new AbortController().signal)).toBe(true);
  expect((await db.query(`select 1 from sandbox_outputs where sandbox_id=$1`, [id])).rows).toHaveLength(1);
  await db.query(`update sandboxes set application_secret_tainted=true,outputs_checked_at=null where id=$1`, [id]);
  expect((await db.query(`select 1 from sandbox_outputs where sandbox_id=$1`, [id])).rows).toHaveLength(0);
  // Neither periodic sampling nor the stop-path final capture executes against tainted compute.
  expect(await service.reconcileOne(new AbortController().signal)).toBe(false);
  await captureFinalOutputs(sql, provider, id, { key });
  expect(calls).toBe(1);
  // A collector that started before taint cannot persist afterwards.
  await expect(
    db.query(`insert into sandbox_outputs(sandbox_id,name,digest,size,content_enc) values($1,'late','d',0,'\\x00')`, [
      id,
    ]),
  ).rejects.toThrow("Sandbox outputs unavailable");
  const route = service.route(async () => ({
    ok: true,
    caller: { userId: people.owner, via: "service", orgs: [{ orgId: people.org, role: "member" }] },
  }));
  const url = `https://armada.example/api/v1/sandboxes/${id}/outputs`;
  expect((await route(new Request(url)))?.status).toBe(404);
  expect((await route(new Request(`${url}/memo.pdf`)))?.status).toBe(404);
});

test("a failed collection keeps the previous snapshot and never fails the shared worker tick", async () => {
  const { db, people } = await database();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status)
    select $1,id,org_id,owner_id,'failing_fixture','codex','ready' from goldens
    where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner],
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
  let exitCode = 0;
  const provider = {
    exec: async () => ({
      detached: false,
      exitCode,
      timedOut: false,
      truncated: false,
      stderr: "",
      stdout: JSON.stringify([{ name: "memo.txt", base64: Buffer.from("draft").toString("base64") }]),
    }),
  } as unknown as Provider;
  const service = createSandboxOutputs(sql, Buffer.alloc(32, 7).toString("base64"), async () => provider);
  expect(await service.reconcileOne(new AbortController().signal)).toBe(true);
  exitCode = 127;
  await db.query(`update sandboxes set outputs_checked_at=null where id=$1`, [id]);
  expect(await service.reconcileOne(new AbortController().signal)).toBe(true);
  expect((await db.query(`select name from sandbox_outputs where sandbox_id=$1`, [id])).rows).toEqual([
    { name: "memo.txt" },
  ]);
});
