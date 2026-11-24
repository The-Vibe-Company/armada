import { expect, test } from "bun:test";
import { type GoldenRecord, parseGoldenConfig } from "@armada/core";
import { encryptSecret, type Sql } from "@armada/core/server";
import { PGlite } from "@electric-sql/pglite";
import { prepareGoldenLaunchAccount } from "../src/launch-account-admission.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";

test("dispatch reauthorizes the selected account revision after provider setup", async () => {
  const key = Buffer.alloc(32, 23).toString("base64");
  const actor = { userId: "owner", orgId: "org", role: "member" as const };
  const account = {
    id: "account",
    kind: "openai" as const,
    status: "active",
    version: 1,
    valueEnc: await encryptSecret("fixture_key", key),
  };
  const credentials = launchCredentials({ credentials: async () => [account], orgBoatKey: async () => null }, key);
  const golden = {
    provider: "boat",
    id: "snapshot",
    name: "web",
    orgId: actor.orgId,
    ownerId: actor.userId,
    visibility: "org",
    modal: null,
    providerSnapshotId: "image",
    providerSandboxId: "builder",
    config: parseGoldenConfig({ repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }] }),
    createdAt: "",
  } satisfies GoldenRecord;
  const prepared = await prepareGoldenLaunchAccount(actor, golden, { harness: "codex" }, credentials, {
    boatRuntime: {
      async start() {
        throw Error("The test exercises account admission only");
      },
    },
  });

  account.version++;
  await expect(prepared.credentials.resolve(actor, "codex")).rejects.toMatchObject({ code: "credential_refused" });
});

test("new launch resolution skips a pooled account until its current revision resets", async () => {
  const db = new PGlite();
  try {
    const actor = { userId: "owner", orgId: "org", role: "member" as const };
    const first = "10000000-0000-4000-8000-000000000001";
    const second = "10000000-0000-4000-8000-000000000002";
    const reset = Date.parse("2026-11-19T14:00:00Z");
    let now = reset - 1;
    await db.exec(`
      create table public.agent_defaults(user_id text,harness text,credential_id uuid,credential_ids uuid[],model text);
      create table public.credentials(id uuid,owner_id text,scope text,kind text,version int,status text,expires_at timestamptz);
      alter table public.credentials add column name text, add column max_agents int, add column model_limits jsonb;
      create table public.account_exhaustion(account_id uuid,account_version int,code text,resets_at timestamptz);
    `);
    await db.query("insert into public.agent_defaults values($1,'codex',$2,$3,null)", [
      actor.userId,
      first,
      [first, second],
    ]);
    await db.query(
      `insert into public.credentials(id,owner_id,scope,kind,version,status,expires_at) values
       ($1,$3,'user','openai',2,'active',null),($2,$3,'user','openai',1,'active',null)`,
      [first, second, actor.userId],
    );
    await db.query("insert into public.account_exhaustion values($1,2,'usage_limit_exceeded',$2)", [
      first,
      new Date(reset).toISOString(),
    ]);

    const key = Buffer.alloc(32, 23).toString("base64");
    const valueEnc = await encryptSecret("fixture_key", key);
    const reader = {
      agentDefaults: async () => [{ harness: "codex" as const, credentialId: first, model: null }],
      credentials: async () => [
        { id: first, kind: "openai" as const, version: 2, valueEnc },
        { id: second, kind: "openai" as const, version: 1, valueEnc },
      ],
      orgBoatKey: async () => null,
    };
    const sql = { query: (query: string, args?: unknown[]) => db.query(query, args) } as Sql;
    const ownership = createModelAuthOwnership(sql, key, () => now);
    const credentials = launchCredentials(reader, key, undefined, ownership);
    const selection = await credentials.defaults?.(actor, "codex");
    const launch = () => credentials.resolve(actor, "codex", selection?.credentialId ?? undefined);
    expect((await launch()).binding?.credentialId).toBe(second);
    expect((await credentials.resolve(actor, "codex", first, 2)).binding?.credentialId).toBe(first);

    await db.query("update public.credentials set status='revoked' where id=$1", [second]);
    await expect(launch()).rejects.toMatchObject({
      code: "credential_refused",
      message: expect.stringContaining("exhausted until 2026-11-19T14:00:00.000Z"),
    });

    now = reset;
    expect((await launch()).binding?.credentialId).toBe(first);

    now = reset - 1;
    await db.query("update public.account_exhaustion set account_version=1 where account_id=$1", [first]);
    expect((await launch()).binding?.credentialId).toBe(first);
  } finally {
    await db.close();
  }
});
