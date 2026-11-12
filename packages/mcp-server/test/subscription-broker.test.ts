import { expect, test } from "bun:test";
import {
  createSqlVaultStore,
  encryptSecret,
  type GoldenActor,
  type Provider,
  ProviderError,
  type Sql,
} from "@armada/core/server";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createHistoricalSandboxProviderResolver } from "../src/mcp-sandbox-provider.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { createSubscriptionBroker } from "../src/subscription-broker.ts";
import { database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

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
    const ownership = createModelAuthOwnership(db, ENCRYPTION_KEY, undefined, undefined, undefined, {
      origin: "https://armada.example",
      fetch: vendor,
    });
    const broker = ownership.broker!;
    const replica = createSubscriptionBroker(db, ENCRYPTION_KEY, "https://armada.example", vendor);
    const resolver = launchCredentials(createSqlVaultStore(db), ENCRYPTION_KEY, undefined, ownership);
    const credentials = await resolver.resolve(actor, "codex", account.id);
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

test("uncertain upstream refresh is never replayed and legacy duplicate writers cannot enroll", async () => {
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
    const legacy = createModelAuthOwnership(db, ENCRYPTION_KEY);
    await legacy.claim(actor, original.id, 1, crypto.randomUUID());
    const duplicate = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc,name) values('user',$1,'codex_auth',$2,'Duplicate') returning id",
        [people.owner, await encryptSecret(raw, ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    let requests = 0;
    const broker = createSubscriptionBroker(db, ENCRYPTION_KEY, "https://armada.example", (async () => {
      requests++;
      throw Error("network lost after dispatch");
    }) as unknown as typeof fetch);
    await expect(broker.enroll(actor, duplicate.id, 1)).rejects.toMatchObject({ code: "credential_busy" });
    await legacy.releaseUnallocated(
      original.id,
      1,
      (
        await db.query<{ sandbox_id: string }>("select sandbox_id from model_auth_ownership where account_id=$1", [
          original.id,
        ])
      ).rows[0]!.sandbox_id,
    );
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

test.each([false, true])(
  "fresh enrollment requires physical proof of the actual recorded ownership holder (recorded=%s)",
  async (recorded) => {
    const { db, people } = await database();
    try {
      const actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "member" };
      const raw = (version: number) =>
        JSON.stringify({
          tokens: {
            access_token: `history-access-${version}`,
            refresh_token: `history-refresh-${version}`,
            account_id: "historical-account",
          },
        });
      const account = (
        await db.query<{ id: string }>(
          "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
          [people.owner, await encryptSecret(raw(1), ENCRYPTION_KEY)],
        )
      ).rows[0]!;
      const original = crypto.randomUUID(),
        ambiguous = crypto.randomUUID();
      const provider = fakeBoat().provider;
      provider.get = async (id) => ({ id, name: id, state: "stopped", providerState: "stopped", labels: {} });
      const observe = async (_tx: Sql, id: string) => ({ provider, providerSandboxId: `physical-${id}` });
      const legacy = createModelAuthOwnership(db, ENCRYPTION_KEY, undefined, undefined, observe);
      const record = async (id: string, version: number) =>
        db.query(
          `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,stopped_at,provider_sandbox_id,boat_id,credential_id,credential_version) select $1,$2,$3,id,'codex','stopped',now(),$4,$4,$5,$6 from goldens where name='shared' and org_id=$2`,
          [id, people.org, people.owner, `physical-${id}`, account.id, version],
        );
      await legacy.claim(actor, account.id, 1, original);
      await record(original, 1);
      await db.query("update credentials set value_enc=$2 where id=$1", [
        account.id,
        await encryptSecret(raw(2), ENCRYPTION_KEY),
      ]);
      await legacy.claim(actor, account.id, 2, ambiguous);
      if (recorded) await record(ambiguous, 2);
      await db.query("update credentials set value_enc=$2 where id=$1", [
        account.id,
        await encryptSecret(raw(3), ENCRYPTION_KEY),
      ]);
      const broker = createSubscriptionBroker(db, ENCRYPTION_KEY, "https://armada.example", fetch, observe);
      if (recorded) {
        await broker.enroll(actor, account.id, 3);
        expect(await broker.enrolled(account.id, 3)).toBe(true);
        expect(
          (await db.query("select 1 from model_auth_ownership where account_id=$1", [account.id])).rows,
        ).toHaveLength(0);
      } else {
        await expect(broker.enroll(actor, account.id, 3)).rejects.toMatchObject({ code: "credential_busy" });
        expect(
          (
            await db.query<{ sandbox_id: string; account_version: number }>(
              "select sandbox_id,account_version from model_auth_ownership where account_id=$1",
              [account.id],
            )
          ).rows[0],
        ).toEqual({ sandbox_id: ambiguous, account_version: 2 });
        expect(await broker.enrolled(account.id, 3)).toBe(false);
      }
    } finally {
      await db.close();
    }
  },
);

test("a replacement that lost an old native identity cannot admit that session under a fresh name", async () => {
  const { db, people } = await database();
  try {
    const actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "member" };
    const raw = (identity: string, token: string) =>
      JSON.stringify({ tokens: { access_token: `access-${token}`, refresh_token: token, account_id: identity } });
    const original = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,name,value_enc) values('user',$1,'codex_auth','Original native identity',$2) returning id",
        [people.owner, await encryptSecret(raw("native-X", "old-X-refresh"), ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    // Pre-enrollment native home: no ownership/state registry exists to recover its identity.
    await db.query(
      `insert into sandboxes(org_id,owner_id,golden_id,harness,status,provider_sandbox_id,boat_id,credential_id,credential_version) select $1,$2,id,'codex','running','old-native-X','old-native-X',$3,1 from goldens where name='shared' and org_id=$1`,
      [people.org, people.owner, original.id],
    );
    await db.query("update credentials set value_enc=$2 where id=$1", [
      original.id,
      await encryptSecret(raw("replacement-Y", "replacement-Y-refresh"), ENCRYPTION_KEY),
    ]);
    const fresh = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,name,value_enc) values('user',$1,'codex_auth','Fresh native X login',$2) returning id",
        [people.owner, await encryptSecret(raw("native-X", "fresh-X-refresh"), ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    const broker = createSubscriptionBroker(db, ENCRYPTION_KEY, "https://armada.example");
    await expect(broker.enroll(actor, fresh.id, 1)).rejects.toMatchObject({ code: "credential_busy" });
    expect(await broker.enrolled(fresh.id, 1)).toBe(false);
  } finally {
    await db.close();
  }
});

const historicalObservations = [
  { provider: "boat", observation: "absent" },
  { provider: "modal", observation: "absent" },
  { provider: "boat", observation: "unavailable" },
  { provider: "boat", observation: "untyped" },
  { provider: "boat", observation: "resolver_absent" },
  { provider: "boat", observation: "foreign_absence" },
  { provider: "boat", observation: "running" },
  { provider: "boat", observation: "wrong_id" },
] as const;

test.each([...historicalObservations])(
  "legacy physical observations gate fresh shared admission (%s)",
  async ({ provider: providerId, observation }) => {
    const { db, people } = await database();
    try {
      const actor: GoldenActor = { userId: people.owner, orgId: people.org, role: "member" };
      const auth = (revision: number) =>
        JSON.stringify({
          tokens: {
            access_token: `absence-access-${revision}`,
            refresh_token: `absence-refresh-${revision}`,
            account_id: "absence-account",
          },
        });
      const account = (
        await db.query<{ id: string }>(
          "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
          [people.owner, await encryptSecret(auth(1), ENCRYPTION_KEY)],
        )
      ).rows[0]!;
      const golden = crypto.randomUUID(),
        historical = crypto.randomUUID();
      await db.query(
        `insert into goldens(id,org_id,owner_id,name,visibility,provider,modal_workspace,modal_environment,modal_app_id,config)
      select $1,org_id,owner_id,'absence-history',visibility,$2::sandbox_provider,$3,$4,$5,config from goldens where org_id=$6 and name='shared' and provider='boat'`,
        [
          golden,
          providerId,
          providerId === "modal" ? "workspace" : null,
          providerId === "modal" ? "environment" : null,
          providerId === "modal" ? "app" : null,
          people.org,
        ],
      );
      await db.query(
        `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,deleted_at,provider,provider_sandbox_id,boat_id,credential_id,credential_version)
      values($1,$2,$3,$4,'codex','deleted',now(),$5::sandbox_provider,'deleted-physical',$6,$7,1)`,
        [
          historical,
          people.org,
          people.owner,
          golden,
          providerId,
          providerId === "boat" ? "deleted-physical" : null,
          account.id,
        ],
      );
      await db.query("update credentials set value_enc=$2 where id=$1", [
        account.id,
        await encryptSecret(auth(2), ENCRYPTION_KEY),
      ]);
      let observations = 0;
      const provider: Provider = {
        ...fakeBoat().provider,
        id: providerId,
        async get(id) {
          observations++;
          expect(id).toBe("deleted-physical");
          if (observation === "untyped") throw Error("not_found");
          if (observation === "running" || observation === "wrong_id")
            return {
              id: observation === "wrong_id" ? "unrelated-physical" : id,
              name: id,
              state: observation === "running" ? "running" : "stopped",
              providerState: observation,
              labels: {},
            };
          throw new ProviderError({
            provider: observation === "foreign_absence" ? "modal" : providerId,
            code: observation === "unavailable" ? "unavailable" : "not_found",
            message: "Synthetic historical observation",
            retryable: observation === "unavailable",
          });
        },
      };
      const historicalProvider = createHistoricalSandboxProviderResolver({
        async resolve(target, caller) {
          expect(target.provider).toBe(providerId);
          expect(caller.userId).toBe(people.owner);
          if (providerId === "modal")
            expect(target.modal).toEqual({ workspace: "workspace", environment: "environment", appId: "app" });
          if (observation === "resolver_absent")
            throw new ProviderError({
              provider: providerId,
              code: "not_found",
              message: "Historical authority unavailable",
              retryable: false,
            });
          return provider;
        },
      });
      const ownership = createModelAuthOwnership(db, ENCRYPTION_KEY, undefined, undefined, historicalProvider, {
        origin: "https://armada.example",
      });
      const broker = ownership.broker!;
      if (observation !== "absent") {
        const attempt = broker.enroll(actor, account.id, 2);
        if (observation === "untyped") await expect(attempt).rejects.toThrow("not_found");
        else
          await expect(attempt).rejects.toMatchObject({
            code:
              observation === "unavailable"
                ? "unavailable"
                : observation === "running" || observation === "wrong_id"
                  ? "credential_busy"
                  : "not_found",
          });
        expect(await broker.enrolled(account.id, 2)).toBe(false);
        if (observation === "resolver_absent") expect(observations).toBe(0);
        return;
      }
      const resolver = launchCredentials(createSqlVaultStore(db), ENCRYPTION_KEY, undefined, ownership);
      const credentials = await resolver.resolve(actor, "codex", account.id, 2);
      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (const id of ids) {
        await resolver.admit!(actor, credentials, id);
        await db.query(
          `insert into sandboxes(id,org_id,owner_id,golden_id,harness,status,provider,provider_sandbox_id,boat_id,credential_id,credential_version,expires_at)
        values($1,$2,$3,$4,'codex','running',$5::sandbox_provider,$6,$7,$8,2,now()+interval '1 hour')`,
          [
            id,
            people.org,
            people.owner,
            golden,
            providerId,
            `new-${id}`,
            providerId === "boat" ? `new-${id}` : null,
            account.id,
          ],
        );
      }
      for (const id of ids) {
        const response = await broker.route(
          new Request("https://armada.example/api/internal/model/access", {
            method: "POST",
            headers: { authorization: `Bearer ${broker.configuration(actor, account.id, 2, id).capability}` },
            body: "{}",
          }),
        );
        expect(response?.status).toBe(200);
        expect(await response!.json()).toMatchObject({ accessToken: "absence-access-2", revision: 0 });
      }
      expect(await broker.enrolled(account.id, 2)).toBe(true);
    } finally {
      await db.close();
    }
  },
  30_000,
);
