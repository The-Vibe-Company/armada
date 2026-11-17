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
