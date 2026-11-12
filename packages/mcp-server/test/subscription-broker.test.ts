import { expect, test } from "bun:test";
import { createSqlVaultStore, encryptSecret, type GoldenActor, type Sql } from "@armada/core/server";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { createSubscriptionBroker } from "../src/subscription-broker.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

test("three current sandbox grants share one server refresh across replicas without receiving refresh tokens", async () => {
  const { db, people } = await database();
  try {
    const actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "member" };
    const raw = JSON.stringify({
      tokens: { access_token: "access-before", refresh_token: "refresh-before", account_id: "shared-account" },
    });
    const account = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
        [people.owner, await encryptSecret(raw, ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    // All former traps coexist: historical failed/deleted, unknown-version live
    // history, and ownership pointing at an allocation that was never recorded.
    for (const [status, version] of [
      ["failed", 1],
      ["deleted", 1],
      ["running", null],
    ] as const) {
      await db.query(
        `insert into sandboxes(org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,credential_id,credential_version,deleted_at)
         select $1,$2,id,'codex',$3::sandbox_status,$4,$4,$5,$6,case when $3='deleted' then now() else null end
         from goldens where name='shared' and org_id=$1`,
        [people.org, people.owner, status, `old-${status}`, account.id, version],
      );
    }
    await db.query("insert into model_auth_ownership(account_id,account_version,sandbox_id) values($1,1,$2)", [
      account.id,
      crypto.randomUUID(),
    ]);
    let requests = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatched!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const vendor = (async (url: string | URL | Request, input?: RequestInit) => {
      expect(String(url)).toBe("https://auth.openai.com/oauth/token");
      expect(JSON.parse(String(input?.body))).toEqual({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: "refresh-before",
      });
      requests++;
      dispatched();
      await gate;
      return Response.json({ access_token: "access-after", refresh_token: "refresh-after" });
    }) as typeof fetch;
    const ownership = createModelAuthOwnership(db, ENCRYPTION_KEY, undefined, undefined, {
      origin: "https://armada.example",
      fetch: vendor,
    });
    const broker = ownership.broker!;
    const replica = createSubscriptionBroker(db, ENCRYPTION_KEY, "https://armada.example", vendor);
    const resolver = launchCredentials(createSqlVaultStore(db), ENCRYPTION_KEY, undefined, ownership);
    const credentials = await resolver.resolve(actor, "codex", account.id);
    expect(credentials.usagePricing).toMatchObject({
      provider: "openai",
      basis: "api_equivalent",
      customEndpoint: false,
      credentialId: account.id,
      credentialVersion: 1,
    });
    expect(JSON.stringify(credentials.usagePricing)).not.toContain("refresh-before");
    expect(JSON.stringify(credentials.usagePricing)).not.toContain("access-before");
    expect(credentials.env.ARMADA_CODEX_AUTH_JSON).toBeUndefined();
    expect(JSON.stringify(credentials.env)).not.toContain("refresh-before");
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) {
      await resolver.admit!(actor, credentials, id);
      await db.query(
        `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,visibility,credential_id,credential_version,expires_at) select $1,$2,$3,id,'codex','running',$4,$4,'org',$5,1,now()+interval '1 hour' from goldens where name='shared' and org_id=$2`,
        [id, people.org, people.owner, `physical-${id}`, account.id],
      );
    }
    for (const id of ids) await resolver.assertTurn!(actor, id, false);
    const request = (index: number, revision?: number) =>
      new Request("https://armada.example/api/internal/model/access", {
        method: "POST",
        headers: { authorization: `Bearer ${broker.configuration(actor, account.id, 1, ids[index]!).capability}` },
        body: JSON.stringify(revision === undefined ? {} : { previousRevision: revision }),
      });
    const initial = await broker.route(request(0));
    expect(await initial?.json()).toEqual({
      accessToken: "access-before",
      chatgptAccountId: "shared-account",
      chatgptPlanType: null,
      revision: 0,
    });
    const first = broker.route(request(0, 0));
    await started;
    const second = replica.route(request(1, 0));
    const third = broker.route(request(2, 0));
    release();
    for (const response of await Promise.all([first, second, third])) {
      expect(response?.status).toBe(200);
      const body = await response!.text();
      expect(JSON.parse(body)).toMatchObject({ accessToken: "access-after", revision: 1 });
      expect(body).not.toContain("refresh-");
    }
    expect(requests).toBe(1);
    expect(await broker.secrets(account.id, 1)).toContain("access-after");
    expect(await broker.secrets(account.id, 1)).toContain(
      broker.configuration(actor, account.id, 1, ids[0]!).capability,
    );
    // Revocation and changed account revisions invalidate every already-issued grant.
    await db.query("update credentials set value_enc=$2 where id=$1", [
      account.id,
      await encryptSecret(raw, ENCRYPTION_KEY),
    ]);
    expect((await broker.route(request(1)))?.status).toBe(403);
  } finally {
    await db.close();
  }
});

test("uncertain upstream refresh is never replayed", async () => {
  const { db, people } = await database();
  try {
    const actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "member" };
    const raw = JSON.stringify({
      tokens: { access_token: "legacy-access", refresh_token: "legacy-refresh", account_id: "legacy-account" },
    });
    const original = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc,name) values('user',$1,'codex_auth',$2,'Original') returning id",
        [people.owner, await encryptSecret(raw, ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    let requests = 0;
    const broker = createSubscriptionBroker(db, ENCRYPTION_KEY, "https://armada.example", (async () => {
      requests++;
      throw Error("network lost after dispatch");
    }) as unknown as typeof fetch);
    await broker.enroll(actor, original.id, 1);
    await expect(broker.access(actor, original.id, 1, 0)).rejects.toMatchObject({ code: "unavailable" });
    expect(requests).toBe(1);
    expect(
      (
        await db.query<{ source_generation: string }>(
          "select source_generation from model_auth_state where account_id=$1",
          [original.id],
        )
      ).rows[0]!.source_generation,
    ).toBe("server:uncertain");
    await expect(broker.access(actor, original.id, 1, 0)).rejects.toMatchObject({ code: "unavailable" });
    expect(requests).toBe(1);
    // Explicit replacement may reconnect, never a hidden retry with the spent token.
    await db.query("update credentials set value_enc=$2 where id=$1", [
      original.id,
      await encryptSecret(raw, ENCRYPTION_KEY),
    ]);
    await expect(broker.access(actor, original.id, 1, 0)).rejects.toMatchObject({ code: "credential_refused" });
    expect(requests).toBe(1);
  } finally {
    await db.close();
  }
});

test("an unauthorized refresh overlapping an ordinary access read still rotates the rejected revision", async () => {
  const { db, people } = await database();
  let release!: () => void;
  try {
    const actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "member" };
    const raw = JSON.stringify({
      tokens: { access_token: "overlap-before", refresh_token: "overlap-refresh", account_id: "overlap-account" },
    });
    const account = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
        [people.owner, await encryptSecret(raw, ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    await createSubscriptionBroker(db, ENCRYPTION_KEY, "https://armada.example").enroll(actor, account.id, 1);
    let selected!: () => void, authorized!: () => void;
    const selecting = new Promise<void>((resolve) => {
      selected = resolve;
    });
    const admitted = new Promise<void>((resolve) => {
      authorized = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let transactions = 0;
    // Gate the read's selection transaction outside the real database connection,
    // allowing the second request's authorization to complete during the read.
    const sql: Sql = {
      query: (query, params) => db.query(query, params),
      transaction: async (work) => {
        const order = ++transactions;
        if (order === 2) {
          selected();
          await gate;
        }
        const result = await db.transaction(work);
        if (order === 3) authorized();
        return result;
      },
    };
    let rotations = 0;
    const broker = createSubscriptionBroker(sql, ENCRYPTION_KEY, "https://armada.example", (async () => {
      rotations++;
      return Response.json({ access_token: "overlap-after", refresh_token: "overlap-next-refresh" });
    }) as unknown as typeof fetch);
    const ordinary = broker.access(actor, account.id, 1);
    await selecting;
    const rejected = broker.access(actor, account.id, 1, 0);
    await admitted;
    release();
    expect((await ordinary).accessToken).toBe("overlap-before");
    expect(await rejected).toMatchObject({ accessToken: "overlap-after", revision: 1 });
    expect(rotations).toBe(1);
  } finally {
    release?.();
    await db.close();
  }
});
