import { expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import { openMigratedDatabase } from "../../../scripts/test-support/migrated-database.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { ENCRYPTION_KEY } from "./support.ts";

async function fixture() {
  const db = await openMigratedDatabase();
  const people = { org: crypto.randomUUID(), owner: crypto.randomUUID(), member: crypto.randomUUID() };
  try {
    // Enrolment needs sandbox ownership and membership, not model/provider credentials.
    await db.query("insert into auth.users(id) values($1),($2)", [people.owner, people.member]);
    await db.query("insert into orgs(id,name) values($1,'Runtime enrolment')", [people.org]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'member'),($1,$3,'member')", [
      people.org,
      people.owner,
      people.member,
    ]);
    await db.query("insert into goldens(org_id,owner_id,name,visibility) values($1,$2,'enrolment-source','private')", [
      people.org,
      people.owner,
    ]);
    const id = crypto.randomUUID();
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,provider_sandbox_id,harness,status,boat_runtime)
     select $1,id,org_id,owner_id,'runtime-native','runtime-native','codex','ready',true from goldens
     where owner_id=$2 and visibility='private' limit 1`,
      [id, people.owner],
    );
    const sql: Sql = {
      query: (q, v) => db.query(q, v),
      transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
    };
    const service = () => createRuntimeEnrolments(sql, ENCRYPTION_KEY);
    const request = async (path: string, bearer: string, epoch?: string) => {
      const response = await service().route(
        new Request(`https://armada.example/api/runtime/${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, ...(epoch ? { "x-armada-runtime-epoch": epoch } : {}) },
        }),
      );
      if (!response) throw Error("missing_runtime_route");
      return response;
    };
    return {
      db,
      people,
      id,
      service,
      request,
      issue: (configuration = { marker: "offline-bootstrap" }) =>
        service().issue({ sandboxId: id, ownerId: people.owner, configuration }),
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

// One owner for one-use exchange, durable replay and replacement fencing: real route + SQL migrations.
test("enrolment is single-use across replicas and replacement epochs fence every prior session", async () => {
  const f = await fixture();
  try {
    const { enrolmentToken } = await f.issue();
    const before = (
      await f.db.query<{ enrolment_hash: string; configuration_enc: Uint8Array }>(
        "select enrolment_hash,configuration_enc from runtime_enrolments",
      )
    ).rows[0];
    expect(before?.enrolment_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(before?.enrolment_hash).not.toBe(enrolmentToken);
    expect(Buffer.from(before?.configuration_enc ?? []).includes(Buffer.from("offline-bootstrap"))).toBe(false);
    const replies = await Promise.all([f.request("enrol", enrolmentToken), f.request("enrol", enrolmentToken)]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 401]);
    const response = replies.find((r) => r.status === 200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const first = (await response?.json()) as { epoch: string; runtimeToken: string; configuration: unknown };
    expect(first.configuration).toEqual({ marker: "offline-bootstrap" });
    expect(first.epoch).toBe("1");
    const after = (
      await f.db.query<{ enrolment_hash: null; configuration_enc: null; runtime_hash: string }>(
        "select enrolment_hash,configuration_enc,runtime_hash from runtime_enrolments",
      )
    ).rows[0];
    expect(after).toMatchObject({ enrolment_hash: null, configuration_enc: null });
    expect(after?.runtime_hash).not.toBe(first.runtimeToken);
    expect((await f.request("session", first.runtimeToken, first.epoch)).status).toBe(200);
    expect((await f.request("session", first.runtimeToken, "2")).status).toBe(401);
    const secondTicket = await f.issue({ marker: "fresh-on-resume" });
    expect((await f.request("session", first.runtimeToken, first.epoch)).status).toBe(401);
    const second = await f.service().enrol(secondTicket.enrolmentToken);
    expect(second.epoch).toBe("2");
    expect(second.configuration).toEqual({ marker: "fresh-on-resume" });
    expect(second.runtimeToken).not.toBe(first.runtimeToken);
    expect((await f.request("session", second.runtimeToken, first.epoch)).status).toBe(401);
    expect((await f.request("session", second.runtimeToken, second.epoch)).status).toBe(200);
    await expect(f.service().enrol(secondTicket.enrolmentToken)).rejects.toThrow("runtime_enrolment_denied");
    await expect(f.service().issue({ sandboxId: f.id, ownerId: f.people.member, configuration: {} })).rejects.toThrow(
      "runtime_enrolment_denied",
    );
  } finally {
    await f.db.close();
  }
});

test("stop, lifecycle replacement and membership removal irreversibly revoke pending and active runtime authority", async () => {
  const f = await fixture();
  try {
    for (const change of ["stop", "lifecycle", "member"] as const) {
      const active = await f.service().enrol((await f.issue()).enrolmentToken);
      if (change === "stop") {
        await f.db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [f.id]);
        await f.db.query("update sandboxes set status='ready',stopped_at=null where id=$1", [f.id]);
      } else if (change === "lifecycle") {
        await f.db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [f.id]);
      } else {
        await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.owner]);
        await f.db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [
          f.people.org,
          f.people.owner,
        ]);
      }
      expect((await f.request("session", active.runtimeToken, active.epoch)).status).toBe(401);
    }
    const pending = await f.issue();
    await f.db.query("update sandboxes set stop_requested_at=now() where id=$1", [f.id]);
    await f.db.query("update sandboxes set stop_requested_at=null where id=$1", [f.id]);
    await expect(f.service().enrol(pending.enrolmentToken)).rejects.toThrow("runtime_enrolment_denied");
    const expired = await f.issue();
    await f.db.query("update runtime_enrolments set enrolment_expires_at=now()-interval '1 second'");
    expect((await f.request("enrol", expired.enrolmentToken)).status).toBe(401);
    const failed = await f.issue();
    await f.db.query("update sandboxes set status='failed' where id=$1", [f.id]);
    await expect(f.service().enrol(failed.enrolmentToken)).rejects.toThrow("runtime_enrolment_denied");
  } finally {
    await f.db.close();
  }
});

test("runtime bootstrap SQL is service-only and private routes reject ambient/malformed tokens without disclosures", async () => {
  const f = await fixture();
  try {
    await f.issue();
    for (const role of ["anon", "authenticated"]) {
      const grants = await f.db.query<{ allowed: boolean }>(
        "select has_table_privilege($1,'public.runtime_enrolments','SELECT') as allowed",
        [role],
      );
      expect(grants.rows[0]?.allowed).toBe(false);
      const writes = await f.db.query<{ allowed: boolean }>(
        "select has_table_privilege($1,'public.runtime_enrolments','INSERT') as allowed",
        [role],
      );
      expect(writes.rows[0]?.allowed).toBe(false);
    }
    const denied = await f.request("enrol", "not-a-runtime-token");
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "runtime_enrolment_denied" });
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(await f.service().route(new Request("https://armada.example/healthz"))).toBeNull();
    expect((await f.service().route(new Request("https://armada.example/api/runtime/enrol")))?.status).toBe(405);
    let mutation = false;
    await expect(
      f.service().withSession("not-a-runtime-token", "1", async () => {
        mutation = true;
      }),
    ).rejects.toThrow("runtime_enrolment_denied");
    expect(mutation).toBe(false);
  } finally {
    await f.db.close();
  }
});

// The happy-path owner is control.test.ts's real launch completion. These are
// lookalike completions which must NOT turn the exception into a fencing bypass.
test("initial handoff exception refuses expired leases, generation jumps, missing prompt and concurrent stop", async () => {
  const f = await fixture();
  try {
    for (const change of ["expired", "jump", "missing-prompt", "stop"]) {
      await f.db.query(
        "update sandboxes set status='starting',stop_requested_at=null,activity_lease_id=$2,activity_until=now()+interval '2 minutes',task_prompt_id=null where id=$1",
        [f.id, crypto.randomUUID()],
      );
      const active = await f.service().enrol((await f.issue()).enrolmentToken);
      if (change === "expired")
        await f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.id]);
      await f.db.query(
        `update sandboxes set status='running',activity_lease_id=null,activity_until=null,
        lifecycle_generation=lifecycle_generation+$2,task_prompt_id=$3,stop_requested_at=$4 where id=$1`,
        [
          f.id,
          change === "jump" ? 2 : 1,
          change === "missing-prompt" ? null : "accepted",
          change === "stop" ? new Date().toISOString() : null,
        ],
      );
      expect((await f.request("session", active.runtimeToken, active.epoch)).status).toBe(401);
      expect(
        (await f.db.query("select runtime_hash from runtime_enrolments where sandbox_id=$1", [f.id])).rows[0],
      ).toEqual({ runtime_hash: null });
    }
    await f.db.query(
      "update sandboxes set status='starting',stop_requested_at=null,activity_lease_id=$2,activity_until=now()+interval '2 minutes' where id=$1",
      [f.id, crypto.randomUUID()],
    );
    const pending = await f.issue();
    await f.db.query(
      "update sandboxes set status='running',activity_lease_id=null,activity_until=null,lifecycle_generation=lifecycle_generation+1,task_prompt_id='accepted' where id=$1",
      [f.id],
    );
    expect((await f.request("enrol", pending.enrolmentToken)).status).toBe(401);
    expect(
      (await f.db.query("select enrolment_hash,configuration_enc from runtime_enrolments where sandbox_id=$1", [f.id]))
        .rows[0],
    ).toEqual({ enrolment_hash: null, configuration_enc: null });
  } finally {
    await f.db.close();
  }
});
