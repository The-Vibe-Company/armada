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
async function fixture(boatRuntime = false) {
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
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,credential_id,credential_version,boat_runtime)
    select $1,id,org_id,owner_id,'native-publisher','codex','ready',$3,1,$4 from goldens where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner, account.id, boatRuntime],
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

test("runtime epoch, membership and pinned credential version fence publication", async () => {
  const f = await fixture();
  try {
    const old = await f.enrol(),
      current = await f.enrol();
    expect((await f.publish(old, native(1), 0)).status).toBe(401);
    expect((await f.publish(current, native(1), 0, { sandboxId: crypto.randomUUID() })).status).toBe(401);
    expect((await f.publish(current, native(1), 0, { generation: old.epoch })).status).toBe(401);
    expect((await f.publish(current, native(1), 0)).status).toBe(200);
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
      ).rows,
    ).toHaveLength(0);
  } finally {
    await f.db.close();
  }
});

test("epoch subscription access round-trips the runtime client, refresh revision and access-only driver callback", async () => {
  const { createRuntimeModelAccess } = await import("../src/runtime-model-access.ts");
  const { RuntimeDialout, runtimeSubscriptionAccess } = await import("../../agent-runtime/src/dialout.ts");
  const f = await fixture();
  try {
    const active = await f.enrol();
    await f.publish(active, native(0), 0);
    await f.db.query("update model_auth_state set source_generation='server:ready'");
    const calls: (number | undefined)[] = [],
      registered: string[] = [];
    const route = createRuntimeModelAccess(f.sql, ENCRYPTION_KEY, {
      async access(actor, id, version, previous) {
        expect([actor.userId, actor.orgId, id, version]).toEqual([f.people.owner, f.people.org, f.account.id, 1]);
        calls.push(previous);
        return {
          accessToken: `access-${calls.length}`,
          chatgptAccountId: "account",
          chatgptPlanType: null,
          revision: calls.length,
          refreshToken: "must-not-cross-runtime-boundary",
        };
      },
    });
    const channel = new RuntimeDialout("https://armada.example", active, {
      async fetch(url, options) {
        expect(url.pathname).toBe("/api/runtime/model-access");
        expect(options.redirect).toBe("error");
        expect(options.credentials).toBe("omit");
        const response = await route(new Request(url.href, options));
        if (!response) throw Error("missing model access route");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.clone().text()).not.toContain("must-not-cross-runtime-boundary");
        return response;
      },
      socket() {
        throw Error("unused socket");
      },
      after() {
        return () => {};
      },
      every() {
        return () => {};
      },
    });
    const access = runtimeSubscriptionAccess(channel, (values) => registered.push(...values));
    const first = await access(false);
    expect(registered).toEqual([first.accessToken]);
    const refreshed = await access(true, first.accessToken);
    expect(calls).toEqual([undefined, 1]);
    expect(refreshed).toEqual({ accessToken: "access-2", chatgptAccountId: "account", chatgptPlanType: null });
    expect(registered).toEqual(["access-1", "access-2"]);
    for (const body of [
      "[]",
      "{",
      JSON.stringify({ accountId: f.account.id }),
      JSON.stringify({ previousRevision: -1 }),
      JSON.stringify({ padding: "x".repeat(1024) }),
    ]) {
      const response = await route(
        new Request("https://armada.example/api/runtime/model-access", {
          method: "POST",
          headers: { authorization: `Bearer ${active.runtimeToken}`, "x-armada-runtime-epoch": active.epoch },
          body,
        }),
      );
      expect(response?.status).toBe(400);
    }
    expect(
      (await route(new Request("https://armada.example/api/runtime/model-access", { method: "POST", body: "{}" })))
        ?.status,
    ).toBe(401);
    expect(await route(new Request("https://armada.example/healthz"))).toBeNull();
    expect(calls).toHaveLength(2);
    await f.enrol();
    await expect(access(false)).rejects.toThrow("runtime_channel_revoked");
    expect(calls).toHaveLength(2);
  } finally {
    await f.db.close();
  }
});

test.each(["epoch", "membership", "pin", "stop", "ownership", "upstream"] as const)(
  "subscription material cannot escape after %s changes during server refresh",
  async (change) => {
    const { createRuntimeModelAccess } = await import("../src/runtime-model-access.ts");
    const { VaultError } = await import("@armada/core/server");
    const f = await fixture();
    try {
      const active = await f.enrol();
      await f.publish(active, native(0), 0);
      await f.db.query("update model_auth_state set source_generation='server:ready'");
      const route = createRuntimeModelAccess(f.sql, ENCRYPTION_KEY, {
        async access() {
          if (change === "epoch") await f.enrol();
          if (change === "membership")
            await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.owner]);
          if (change === "pin") {
            await f.db.query("update credentials set value_enc=$2 where id=$1", [
              f.account.id,
              await encryptSecret(native(1), ENCRYPTION_KEY),
            ]);
            expect(
              (await f.db.query<{ version: number }>("select version from credentials where id=$1", [f.account.id]))
                .rows[0]?.version,
            ).toBe(2);
          }
          if (change === "stop") await f.db.query("update sandboxes set stop_requested_at=now() where id=$1", [f.id]);
          if (change === "ownership") await f.db.query("update model_auth_state set source_generation='runtime:other'");
          if (change === "upstream") throw new VaultError("unavailable", "private-upstream-marker");
          return {
            accessToken: "private-access-marker",
            chatgptAccountId: "account",
            chatgptPlanType: null,
            revision: 1,
          };
        },
      });
      const response = await route(
        new Request("https://armada.example/api/runtime/model-access", {
          method: "POST",
          headers: { authorization: `Bearer ${active.runtimeToken}`, "x-armada-runtime-epoch": active.epoch },
          body: "{}",
        }),
      );
      expect(response?.status).toBe(change === "upstream" ? 503 : 401);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      expect(await response?.text()).not.toContain("private-");
    } finally {
      await f.db.close();
    }
  },
);

test("two Boat runtime guests share server renewal and a replacement epoch reads the persisted revision", async () => {
  const { createRuntimeModelAccess } = await import("../src/runtime-model-access.ts");
  const { RuntimeDialout, runtimeSubscriptionAccess } = await import("../../agent-runtime/src/dialout.ts");
  const f = await fixture(true);
  try {
    let renewals = 0;
    const ownership = createModelAuthOwnership(f.sql, ENCRYPTION_KEY, undefined, undefined, {
      origin: "https://armada.example",
      fetch: (async (_url, init) => {
        expect(JSON.parse(String(init?.body)).refresh_token).toBe("offline-refresh-0");
        renewals++;
        return Response.json({ access_token: "renewed-access", refresh_token: "renewed-refresh" });
      }) as typeof fetch,
    });
    if (!ownership.broker) throw Error("missing broker");
    await ownership.broker.enroll(f.actor, f.account.id, 1);
    const secondId = crypto.randomUUID();
    await f.db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,credential_id,credential_version,boat_runtime)
       select $2,golden_id,org_id,owner_id,'second-runtime','codex','ready',credential_id,credential_version,true from sandboxes where id=$1`,
      [f.id, secondId],
    );
    const first = await f.enrol();
    const second = await f.authority.enrol(
      (await f.authority.issue({ ownerId: f.people.owner, sandboxId: secondId, configuration: {} })).enrolmentToken,
    );
    // Reconstruct the route and broker on resume, as after a server restart.
    const routeFor = (auth: typeof ownership) => createRuntimeModelAccess(f.sql, ENCRYPTION_KEY, auth.broker);
    const connect = (active: typeof first, route: ReturnType<typeof routeFor>) => {
      const registered: string[] = [];
      const channel = new RuntimeDialout("https://armada.example", active, {
        async fetch(url, options) {
          const response = await route(new Request(url.href, options));
          if (!response) throw Error("missing model access route");
          const body = await response.clone().text();
          expect(body).not.toContain("offline-refresh-0");
          expect(body).not.toContain("renewed-refresh");
          return response;
        },
        socket() {
          throw Error("unused socket");
        },
        after() {
          return () => {};
        },
        every() {
          return () => {};
        },
      });
      return { registered, access: runtimeSubscriptionAccess(channel, (values) => registered.push(...values)) };
    };
    const route = routeFor(ownership);
    const a = connect(first, route),
      b = connect(second, route);
    const [initialA, initialB] = await Promise.all([a.access(false), b.access(false)]);
    expect(initialA.accessToken).toBe("offline-access-0");
    expect(initialB.accessToken).toBe("offline-access-0");
    const refreshed = await a.access(true, initialA.accessToken);
    // A second guest's stale refresh request must reuse the already committed rotation.
    expect(await b.access(true, initialB.accessToken)).toEqual(refreshed);
    expect(renewals).toBe(1);
    expect(a.registered).toEqual(["offline-access-0", "renewed-access"]);
    expect(b.registered).toEqual(["offline-access-0", "renewed-access"]);
    const replacement = await f.enrol();
    await expect(a.access(false)).rejects.toThrow("runtime_channel_revoked");
    const restarted = createModelAuthOwnership(f.sql, ENCRYPTION_KEY, undefined, undefined, {
      origin: "https://armada.example",
      fetch: (async (_url, _init) =>
        Response.json({ error: "unexpected resume renewal" }, { status: 500 })) as typeof fetch,
    });
    expect(await connect(replacement, routeFor(restarted)).access(false)).toEqual(refreshed);
    expect(await b.access(false)).toEqual(refreshed);
    const state = await restarted.state.read(f.actor, f.account.id, 1, f.id);
    expect(state).toMatchObject({ sourceGeneration: "server:ready", revision: 1 });
    expect(JSON.parse(state?.authJson ?? "{}").tokens.refresh_token).toBe("renewed-refresh");
    expect((await f.db.query("select sequence from runtime_events")).rows).toEqual([]);
  } finally {
    await f.db.close();
  }
});
