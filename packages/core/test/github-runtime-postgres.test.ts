import { describe, expect, test } from "bun:test";
import { captureGitHubAuditLogs } from "../../../scripts/test-support/github-audit.ts";
import { sqlOver } from "../../mcp-server/src/sql.ts";
import { decryptSecret, encryptSecret } from "../src/crypto.ts";
import { resolveGitHubAccess } from "../src/github.ts";
import type { Sql } from "../src/golden-store.ts";
import { createSqlVaultStore } from "../src/vault-store.ts";

// Real PostgreSQL proves refresh never reserves the sole main-pool connection during HTTP,
// and that the durable pre-request fence survives a failed rotation publication.
describe.skipIf(!process.env.ARMADA_TEST_POSTGRES_URL)("GitHub managed refresh (PostgreSQL)", () => {
  test("same-owner expiry rotates once; HTTP leaves the sole main connection free for other owners", async () => {
    await fixture(async (world) => {
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
      world.pauseRefresh = async (id) => {
        if (id === 1) {
          entered();
          await gate;
        }
      };
      const first = world.resolve(0);
      await reached;
      try {
        expect(await world.resolve(0, { ...world.sql })).toMatchObject({ status: "unavailable" });
        expect(await world.resolve(1)).toMatchObject({ status: "connected", identity: { id: 2 } });
      } finally {
        release();
      }
      expect(await first).toMatchObject({ status: "connected", identity: { id: 1 } });
      world.pauseRefresh = undefined;
      world.advance();
      const results = await Promise.all([world.resolve(0), world.resolve(0), world.resolve(0)]);
      for (const access of results)
        expect(access).toMatchObject({ status: "connected", token: world.currentAccess(0) });
      expect(world.refreshes()).toBe(3); // owner1 initial + owner2 initial + ONE owner1 expiry rotation
      const row = (
        await world.sql.query<{ refresh_token_enc: Uint8Array }>(
          "select refresh_token_enc from public.github_connections where user_id=$1",
          [world.users[0]],
        )
      ).rows[0];
      expect(await decryptSecret(new Uint8Array(row!.refresh_token_enc), world.key)).toBe(world.currentRefresh(0));
    });
  });
  test("remote success followed by SQL rollback keeps the durable consumed fence and never replays", async () => {
    await fixture(async (world) => {
      const faulty: Sql = {
        autonomousQuery: world.sql.autonomousQuery!,
        query: async <T>(text: string, params?: unknown[]) => {
          if (!text.includes("set refresh_token_enc")) return world.sql.query<T>(text, params);
          return world.sql.transaction!(async (tx) => {
            await tx.query<T>(text, params);
            throw Error("forced_commit_uncertain");
          });
        },
      };
      await expect(world.resolve(0, faulty)).rejects.toThrow("forced_commit_uncertain");
      expect(await world.resolve(0)).toMatchObject({ status: "unavailable" });
      expect(world.refreshes()).toBe(1);
      const rows = await world.sql.query<{ count: string }>(
        "select count(*)::text as count from public.github_refresh_fences where user_id=$1",
        [world.users[0]],
      );
      expect(rows.rows[0]?.count).toBe("1");
    });
  });
});

async function fixture(work: (world: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const world = await setup();
  try {
    await work(world);
  } finally {
    await world.sql.query("delete from auth.users where id=any($1::uuid[])", [world.users]);
    await world.client.close();
    await world.autonomous.close();
  }
}
async function setup() {
  const location = process.env.ARMADA_TEST_POSTGRES_URL;
  if (!location) throw Error("Local disposable PostgreSQL fixture is required");
  const client = new Bun.SQL(location, { max: 1 });
  const autonomous = new Bun.SQL(location, { max: 1 });
  const sql = sqlOver({
    unsafe: (text, params) => client.unsafe(text, params),
    autonomous: (text, params) => autonomous.unsafe(text, params),
    begin: (fn) => client.begin((tx) => fn({ unsafe: (text, params) => tx.unsafe(text, params) })),
  });
  const users = [crypto.randomUUID(), crypto.randomUUID()];
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const grants = users.map((_, index) => ({
    id: index + 1,
    refresh: `offline-r-${crypto.randomUUID()}`,
    access: "",
    expires: 0,
  }));
  let clock = Date.now(),
    count = 0;
  const world = {
    client,
    autonomous,
    sql,
    users,
    key,
    pauseRefresh: undefined as undefined | ((id: number) => Promise<void>),
    advance: () => {
      clock += 400000;
    },
    refreshes: () => count,
    currentAccess: (i: number) => grants[i]!.access,
    currentRefresh: (i: number) => grants[i]!.refresh,
    resolve: (i: number, storeSql: Sql = sql) =>
      resolveGitHubAccess(
        {
          store: createSqlVaultStore(storeSql),
          encryptionKey: key,
          app: { clientId: "offline", clientSecret: "offline" },
          now: () => new Date(clock),
          fetch: issuer,
        },
        users[i]!,
      ),
  };
  const issuer = (async (input: string | Request | URL, init?: RequestInit) => {
    if (String(input) === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body));
      const grant = grants.find((g) => g.refresh === body.refresh_token);
      if (!grant) return Response.json({ error: "bad_refresh_token" });
      count++;
      grant.refresh = `offline-r-${crypto.randomUUID()}`;
      grant.access = `offline-a-${crypto.randomUUID()}`;
      grant.expires = clock + 600000;
      await world.pauseRefresh?.(grant.id);
      return Response.json({ access_token: grant.access, refresh_token: grant.refresh, expires_in: 600 });
    }
    const access = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
    const grant = grants.find((g) => g.access === access && g.expires > clock);
    if (!grant) return Response.json({ message: "Rejected" }, { status: 401 });
    return Response.json({ id: grant.id, login: `owner${grant.id}`, name: `Owner ${grant.id}` });
  }) as unknown as typeof fetch;
  for (let i = 0; i < users.length; i++) {
    await sql.query("insert into auth.users(id) values($1)", [users[i]]);
    await sql.query(
      "insert into public.github_connections(user_id,github_id,login,name,refresh_token_enc) values($1,$2,$3,$4,$5)",
      [users[i], i + 1, `owner${i + 1}`, `Owner ${i + 1}`, await encryptSecret(grants[i]!.refresh, key)],
    );
  }
  return world;
}

// Token resolution in these fixtures must not leak audit records to stdout.
captureGitHubAuditLogs();
