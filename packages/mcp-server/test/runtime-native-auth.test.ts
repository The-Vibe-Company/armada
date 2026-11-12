import { expect, test } from "bun:test";
import { encryptSecret, type GoldenActor, type Sql } from "@armada/core/server";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeNativeAuth } from "../src/runtime-native-auth.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

const native = (revision: number, account = "offline-account") =>
  JSON.stringify({
    tokens: {
      account_id: account,
      access_token: `offline-access-${revision}`,
      refresh_token: `offline-refresh-${revision}`,
    },
  });
async function fixture() {
  const { db, people } = await database();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const account = (
    await db.query<{ id: string }>(
      "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
      [people.owner, await encryptSecret(native(0), ENCRYPTION_KEY)],
    )
  ).rows[0];
  if (!account) throw Error("missing fixture account");
  const id = crypto.randomUUID(),
    actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "member" };
  const ownership = createModelAuthOwnership(sql, ENCRYPTION_KEY);
  await ownership.claimLegacy(actor, account.id, 1, id);
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,credential_id,credential_version)
    select $1,id,org_id,owner_id,'native-publisher','codex','ready',$3,1 from goldens where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner, account.id],
  );
  const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  const enrol = async () =>
    authority.enrol(
      (await authority.issue({ ownerId: people.owner, sandboxId: id, configuration: {} })).enrolmentToken,
    );
  const publisher = createRuntimeNativeAuth(sql, ENCRYPTION_KEY);
  const publish = async (
    active: Awaited<ReturnType<typeof enrol>>,
    authJson: string,
    expectedRevision: number,
    extra = {},
  ) => {
    const response = await createRuntimeEvents(authority, ENCRYPTION_KEY, publisher).route(
      new Request("https://armada.example/api/runtime/events", {
        method: "POST",
        headers: { authorization: `Bearer ${active.runtimeToken}`, "x-armada-runtime-epoch": active.epoch },
        body: JSON.stringify({
          sandboxId: id,
          generation: active.epoch,
          events: [],
          nativeAuth: { authJson, expectedRevision },
          ...extra,
        }),
      }),
    );
    if (!response) throw Error("missing native publication route");
    return response;
  };
  return { db, sql, people, id, actor, account, ownership, authority, enrol, publisher, publish };
}

test("private runtime renewal seals state once, retains retired leaves, and returns honest CAS receipts", async () => {
  const f = await fixture();
  try {
    const active = await f.enrol();
    expect(await (await f.publish(active, native(1), 0)).json()).toEqual({ authRevision: 1, committed: true });
    expect(await (await f.publish(active, native(1), 0)).json()).toEqual({ authRevision: 1, committed: true });
    expect(await (await f.publish(active, native(2), 0)).json()).toEqual({ authRevision: 1, committed: false });
    expect(await (await f.publish(active, native(2), 1)).json()).toEqual({ authRevision: 2, committed: true });
    const state = await f.ownership.state.read(f.actor, f.account.id, 1, f.id);
    expect(state).toMatchObject({ authJson: native(2), revision: 2, sourceGeneration: `runtime:${active.epoch}` });
    expect(state?.secrets).toContain("offline-refresh-0");
    expect(state?.secrets).toContain("offline-refresh-1");
    expect(state?.secrets).toContain("offline-refresh-2");
    const stored = (
      await f.db.query<{ state_enc: Uint8Array }>("select state_enc from model_auth_state where account_id=$1", [
        f.account.id,
      ])
    ).rows[0];
    expect(Buffer.from(stored?.state_enc ?? []).includes(Buffer.from("offline-refresh-2"))).toBe(false);
    expect((await f.db.query("select sequence from runtime_events")).rows).toHaveLength(0);
    const wrong = await f.publish(active, native(3, "another-account"), 2);
    expect(await wrong.json()).toEqual({ authRevision: 2, committed: false });
    expect((await f.ownership.state.read(f.actor, f.account.id, 1, f.id))?.authJson).toBe(native(2));
    expect(wrong.headers.get("cache-control")).toBe("no-store");
  } finally {
    await f.db.close();
  }
});

test("runtime epoch, membership, pinned credential version and exclusive account holder fence publication", async () => {
  const f = await fixture();
  try {
    const old = await f.enrol(),
      current = await f.enrol();
    expect((await f.publish(old, native(1), 0)).status).toBe(401);
    expect((await f.publish(current, native(1), 0, { sandboxId: crypto.randomUUID() })).status).toBe(401);
    expect((await f.publish(current, native(1), 0, { generation: old.epoch })).status).toBe(401);
    expect((await f.publish(current, native(1), 0)).status).toBe(200);
    const other = crypto.randomUUID();
    await f.db.query("update model_auth_ownership set sandbox_id=$2 where account_id=$1", [f.account.id, other]);
    expect((await f.publish(current, native(2), 1)).status).toBe(401);
    await f.db.query("update model_auth_ownership set sandbox_id=$2 where account_id=$1", [f.account.id, f.id]);
    await f.db.query("update credentials set value_enc=$2 where id=$1", [
      f.account.id,
      await encryptSecret(native(9), ENCRYPTION_KEY),
    ]);
    expect((await f.publish(current, native(2), 1)).status).toBe(401);
    const stored = (
      await f.db.query<{ auth_revision: number }>("select auth_revision from model_auth_state where account_id=$1", [
        f.account.id,
      ])
    ).rows[0];
    expect(stored?.auth_revision).toBe(1);
  } finally {
    await f.db.close();
  }
});

test("malformed/mixed native publications never masquerade as journal ACKs or disclose auth material", async () => {
  const f = await fixture();
  try {
    const active = await f.enrol();
    for (const [raw, revision] of [
      ["invalid", 0],
      [native(1), -1],
      ["x".repeat(65537), 0],
    ] as const) {
      const response = await f.publish(active, raw, revision);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_runtime_events" });
    }
    expect(
      (
        await f.publish(active, native(1), 0, {
          events: [{ sequence: 1, event: { id: "mixed", at: 1, kind: "other", type: "fixture", data: {} } }],
        })
      ).status,
    ).toBe(400);
    expect((await f.db.query("select sequence from runtime_events")).rows).toHaveLength(0);
    expect(
      (
        await f.db.query<{ auth_revision: number }>("select auth_revision from model_auth_state where account_id=$1", [
          f.account.id,
        ])
      ).rows[0]?.auth_revision,
    ).toBe(0);
  } finally {
    await f.db.close();
  }
});
