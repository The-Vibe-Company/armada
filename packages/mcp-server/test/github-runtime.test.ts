import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createSqlSandboxStore,
  createSqlVaultStore,
  encryptSecret,
  type GitHubRuntimeConfiguration,
  type Provider,
} from "@armada/core/server";
import { createGitHubRuntime } from "../src/github-runtime.ts";
import { migratedDatabase } from "./migrated-database.ts";

test("private GitHub issuance rechecks original owner/org/physical identity and late SQL lifecycle changes", async () => {
  const db = await migratedDatabase();
  try {
    const owner = crypto.randomUUID(),
      admin = crypto.randomUUID(),
      org = crypto.randomUUID(),
      other = crypto.randomUUID(),
      golden = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1),($2)", [owner, admin]);
    await db.query("insert into public.orgs(id,name) values($1,'GitHub runtime'),($2,'Other')", [org, other]);
    await db.query(
      "insert into public.members(org_id,user_id,role) values($1,$2,'member'),($1,$3,'admin'),($4,$3,'admin')",
      [org, owner, admin, other],
    );
    await db.query(
      "insert into public.goldens(id,org_id,owner_id,name,visibility,config) values($1,$2,$3,'runtime','org',$4::jsonb)",
      [golden, org, owner, JSON.stringify({ repos: [{ url: "https://github.com/acme/repo.git" }], init: [] })],
    );
    const sandbox = await createSqlSandboxStore(db).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "bx_692",
      goldenId: golden,
      orgId: org,
      ownerId: owner,
      visibility: "org",
      harness: "codex",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
      status: "ready",
    });
    await db.query("update public.sandboxes set expires_at=now()+interval '1 hour' where id=$1", [sandbox.id]);
    const key = Buffer.alloc(32, 11).toString("base64");
    const access = `offline-${crypto.randomUUID()}`;
    await db.query(
      "insert into public.github_connections(user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at) values($1,123,$2,$2,$3,$4,now()+interval '1 hour')",
      [owner, "owner", await encryptSecret("offline-refresh", key), await encryptSecret(access, key)],
    );
    let configuration: GitHubRuntimeConfiguration | null = null,
      generation = "boot-one",
      backend = "account-one";
    let userHook: undefined | (() => Promise<void>);
    const provider = {
      id: "boat",
      backendIdentity: async () => ({ id: backend }),
      get: async () => ({
        id: "bx_692",
        state: "running",
        physicalGeneration: generation,
        expiresAt: new Date(Date.now() + 3600000),
      }),
      configureGitHub: async (input: { configuration: GitHubRuntimeConfiguration | null }) => {
        configuration = input.configuration;
        return { acknowledged: true };
      },
    } as unknown as Provider;
    // SQL policy owner: PGlite cannot prove cross-connection advisory locks. Owner locking and durable
    // pre-refresh commits have a separate real-PostgreSQL owner test, not a fake PGlite lock claim.
    const runtime = createGitHubRuntime({
      sql: db,
      origin: "https://armada.example",
      providerForSandbox: async () => provider,
      github: {
        store: createSqlVaultStore({ query: db.query.bind(db) }),
        encryptionKey: key,
        app: { clientId: "offline", clientSecret: "offline" },
        fetch: (async () => {
          await userHook?.();
          return Response.json({ id: 123, login: "owner", name: "owner" });
        }) as unknown as typeof fetch,
      },
    });
    await runtime.prepare(provider, sandbox.id);
    const current = () => {
      if (!configuration) throw Error("No private configuration");
      return configuration;
    };
    const call = async (extra: Record<string, unknown> = {}) =>
      runtime.route(
        new Request("https://armada.example/api/internal/github/credentials", {
          method: "POST",
          headers: { authorization: `Bearer ${current().capability}` },
          body: JSON.stringify({ version: 1, repository: "acme/repo", operation: "git", ...extra }),
        }),
      );
    expect((await call())?.status).toBe(200);
    for (const extra of [
      { ownerId: admin },
      { orgId: other },
      { providerSandboxId: "bx_foreign" },
      { repository: "foreign/repo" },
      { operation: "vault" },
    ])
      expect((await call(extra))?.status).toBe(403);
    const stored = (
      await db.query<{ hash: string }>("select hash from public.github_runtime_capabilities where sandbox_id=$1", [
        sandbox.id,
      ])
    ).rows;
    expect(stored).toEqual([{ hash: createHash("sha256").update(current().capability).digest("hex") }]);
    backend = "different";
    expect((await call())?.status).toBe(403);
    backend = "account-one";
    generation = "different";
    expect((await call())?.status).toBe(403);
    generation = "boot-one";
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        reached = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    userHook = async () => {
      reached();
      await gate;
    };
    const pending = call();
    await entered;
    await db.query("update public.sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [sandbox.id]);
    release();
    expect((await pending)?.status).toBe(403);
    userHook = undefined;
    // Normal activity changes are not a new physical epoch: a fresh request takes a new SQL sample.
    expect((await call())?.status).toBe(200);
    await db.query("delete from public.members where org_id=$1 and user_id=$2", [org, owner]);
    expect((await call())?.status).toBe(403);
    await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'member')", [org, owner]);
    expect((await call())?.status).toBe(403); // Removal/re-add never resurrects the old capability.
    await runtime.prepare(provider, sandbox.id);
    expect((await call())?.status).toBe(200);
    await db.query("update public.github_connections set revoked_at=now() where user_id=$1", [owner]);
    expect((await call())?.status).toBe(403);
  } finally {
    await db.close();
  }
});
