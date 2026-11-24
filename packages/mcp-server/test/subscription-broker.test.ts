import { expect, test } from "bun:test";
import { createSqlVaultStore, decryptSecret, encryptSecret, type GoldenActor, type Sql } from "@armada/core/server";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { createSubscriptionBroker } from "../src/subscription-broker.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const database = rowOnlyDatabase();

test("three subscription launches prompt despite historical sandbox rows and share one refresh across replicas", async () => {
  const { db, people } = await database();
  let release: (() => void) | undefined;
  const pending: Promise<unknown>[] = [];
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
    // Historical failed/deleted sandboxes and live sandboxes with no known credential version coexist.
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
    let requests = 0;
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
    const ownership = createModelAuthOwnership(db, ENCRYPTION_KEY, undefined, {
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
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const sandboxId = crypto.randomUUID();
      await db.query(
        `insert into sandboxes(id,org_id,owner_id,golden_id,provider_sandbox_id,status,harness,credential_id,credential_version,expires_at)
         select $1,$2,$3,g.id,$4,'ready','codex',$5,1,now()+interval '1 hour'
         from goldens g where g.org_id=$2 and g.name='shared'`,
        [sandboxId, actor.orgId, actor.userId, `subscription-${index}`, account.id],
      );
      ids.push(sandboxId);
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
    pending.push(first);
    await started;
    const second = replica.route(request(1, 0));
    pending.push(second);
    const third = broker.route(request(2, 0));
    pending.push(third);
    // A late authenticated guest observation updates only the sealed registry
    // while the vendor response is pending, not the broker's auth revision.
    await db.transaction(async (tx) => {
      const row = (
        await tx.query<{ state_enc: Uint8Array }>(
          "select state_enc from model_auth_state where account_id=$1 and account_version=1 for update",
          [account.id],
        )
      ).rows[0]!;
      const observed = JSON.parse(await decryptSecret(new Uint8Array(row.state_enc), ENCRYPTION_KEY));
      observed.secrets.push("late-native-observation");
      observed.brokerDeliveries = { [ids[0]!]: 2 };
      await tx.query("update model_auth_state set state_enc=$2 where account_id=$1 and account_version=1", [
        account.id,
        await encryptSecret(JSON.stringify(observed), ENCRYPTION_KEY),
      ]);
    });
    release?.();
    for (const response of await Promise.all([first, second, third])) {
      expect(response?.status).toBe(200);
      const body = await response!.text();
      expect(JSON.parse(body)).toMatchObject({ accessToken: "access-after", revision: 1 });
      expect(body).not.toContain("refresh-");
    }
    expect(requests).toBe(1);
    expect(await broker.secrets(account.id, 1)).toContain("late-native-observation");
    const registry = (
      await db.query<{ state_enc: Uint8Array }>(
        "select state_enc from model_auth_state where account_id=$1 and account_version=1",
        [account.id],
      )
    ).rows[0]!;
    expect(
      JSON.parse(await decryptSecret(new Uint8Array(registry.state_enc), ENCRYPTION_KEY)).brokerDeliveries,
    ).toEqual({ [ids[0]!]: 2 });
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
    release?.();
    await Promise.allSettled(pending);
  }
});

test("uncertain upstream refresh is never replayed", async () => {
  const { db, people } = await database();
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
  let reply: "lost" | "temporary" | "success" = "lost";
  const broker = createSubscriptionBroker(db, ENCRYPTION_KEY, "https://armada.example", (async () => {
    requests++;
    if (reply === "temporary") return Response.json({ error: "upstream_private_detail" }, { status: 503 });
    if (reply === "success")
      return Response.json({ access_token: "recovered-access", refresh_token: "recovered-refresh" });
    throw Error("network lost after dispatch");
  }) as unknown as typeof fetch);
  await broker.enroll(actor, original.id, 1);
  await expect(broker.access(actor, original.id, 1, 0)).rejects.toMatchObject({
    code: "unavailable",
    message: "Sign in again to this ChatGPT account.",
  });
  expect(requests).toBe(1);
  expect(
    (
      await db.query<{ source_generation: string }>(
        "select source_generation from model_auth_state where account_id=$1",
        [original.id],
      )
    ).rows[0]!.source_generation,
  ).toBe("server:uncertain");
  await expect(broker.access(actor, original.id, 1, 0)).rejects.toMatchObject({
    code: "unavailable",
    message: "Sign in again to this ChatGPT account.",
  });
  expect(requests).toBe(1);
  await expect(broker.enroll(actor, original.id, 1)).rejects.toMatchObject({
    code: "unavailable",
    message: "Sign in again to this ChatGPT account.",
  });
  expect(requests).toBe(1);
  // Explicit replacement may reconnect, never a hidden retry with the spent token.
  await db.query("update credentials set value_enc=$2 where id=$1", [
    original.id,
    await encryptSecret(raw, ENCRYPTION_KEY),
  ]);
  await expect(broker.access(actor, original.id, 1, 0)).rejects.toMatchObject({ code: "credential_refused" });
  expect(requests).toBe(1);
  await broker.enroll(actor, original.id, 2);
  reply = "temporary";
  await expect(broker.access(actor, original.id, 2, 0)).rejects.toMatchObject({
    code: "unavailable",
    message: "Model sign-in is temporarily unavailable. Try again.",
  });
  expect(
    (
      await db.query<{ source_generation: string }>(
        "select source_generation from model_auth_state where account_id=$1 and account_version=2",
        [original.id],
      )
    ).rows[0]?.source_generation,
  ).toBe("server:ready");
  reply = "success";
  expect(await broker.access(actor, original.id, 2, 0)).toMatchObject({
    accessToken: "recovered-access",
    revision: 1,
  });
  expect(requests).toBe(3);
});

test("an unauthorized refresh overlapping an ordinary access read still rotates the rejected revision", async () => {
  const { db, people } = await database();
  let release: (() => void) | undefined;
  const pending: Promise<unknown>[] = [];
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
    pending.push(ordinary);
    await selecting;
    const rejected = broker.access(actor, account.id, 1, 0);
    pending.push(rejected);
    await admitted;
    release?.();
    expect((await ordinary).accessToken).toBe("overlap-before");
    expect(await rejected).toMatchObject({ accessToken: "overlap-after", revision: 1 });
    expect(rotations).toBe(1);
  } finally {
    release?.();
    await Promise.allSettled(pending);
  }
});
