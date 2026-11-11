import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { sqlOver } from "../../mcp-server/src/sql.ts";
import { encryptSecret } from "../src/crypto.ts";
import { resolveGitHubAccess } from "../src/github.ts";
import { createSqlVaultStore } from "../src/vault-store.ts";

// This URL must allow CREATE DATABASE. Each case owns a disposable database.
describe.skipIf(!process.env.ARMADA_TEST_POSTGRES_URL)("GitHub reconnect (PostgreSQL)", () => {
  test("reconnect completes during profile HTTP and stale publication cannot overwrite its identity", async () => {
    const postgresUrl = process.env.ARMADA_TEST_POSTGRES_URL;
    if (!postgresUrl) throw new Error("ARMADA_TEST_POSTGRES_URL is required");
    const admin = new Bun.SQL(postgresUrl);
    const name = `reconnect_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`create database ${name}`);
    const url = new URL(postgresUrl);
    url.pathname = `/${name}`;
    url.searchParams.set("options", "-c statement_timeout=500 -c synchronous_commit=off");
    const one = new Bun.SQL(url.toString(), { max: 2 });
    url.searchParams.set("options", "-c statement_timeout=5000 -c synchronous_commit=off");
    const two = new Bun.SQL(url.toString(), { max: 1 });
    const observer = new Bun.SQL(url.toString(), { max: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first: Promise<unknown> | undefined;
    let reconnect: Promise<unknown> | undefined;
    try {
      // Roles are cluster-wide; the disposable database supplies only the schema.
      const prereq = await Bun.file("scripts/db/supabase-prereq.sql").text();
      for (const role of ["anon", "authenticated", "service_role"]) {
        if (!(await admin.unsafe("select 1 from pg_roles where rolname = $1", [role])).length)
          await admin.unsafe(`create role ${role} nologin${role === "service_role" ? " bypassrls" : ""}`);
      }
      await one.unsafe(prereq.replace(/^create role .*;$/gm, ""));
      for (const file of readdirSync("supabase/migrations")
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await one.unsafe(await Bun.file(`supabase/migrations/${file}`).text());
      const userId = crypto.randomUUID();
      const key = Buffer.alloc(32, 9).toString("base64");
      await one.unsafe("insert into auth.users (id) values ($1)", [userId]);
      await one.unsafe(
        "insert into github_connections (user_id, github_id, login, refresh_token_enc) values ($1, 1, 'old', $2)",
        [userId, await encryptSecret("refresh-a", key)],
      );
      // Record public profile changes to prove stale HTTP completion never replaces reconnect.
      await one.unsafe(`
        create table profile_changes (login text);
        create function record_profile() returns trigger language plpgsql as $$
        begin
          if new.login is distinct from old.login then
            insert into profile_changes values (new.login);
          end if;
          return new;
        end; $$;
        create trigger profile_change after update on github_connections
          for each row execute function record_profile();
      `);
      let entered!: () => void;
      const fetchingProfile = new Promise<void>((resolve) => {
        entered = resolve;
      });
      first = resolveGitHubAccess(
        {
          store: createSqlVaultStore(
            sqlOver({
              unsafe: (text, params) => one.unsafe(text, params),
              autonomous: (text, params) => observer.unsafe(text, params),
              begin: (work) => one.begin((tx) => work({ unsafe: (text, params) => tx.unsafe(text, params) })),
            }),
          ),
          encryptionKey: key,
          app: { clientId: "app", clientSecret: "secret" },
          fetch: (async (request) => {
            if (String(request).includes("access_token"))
              return Response.json({ access_token: "access-a", refresh_token: "rotated-a", expires_in: 28800 });
            entered();
            await held;
            return Response.json({ id: 1, login: "renamed-a", name: "A" });
          }) as typeof fetch,
        },
        userId,
      );
      await fetchingProfile;
      reconnect = two.begin(async (tx) => {
        await tx.unsafe("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
        await tx.unsafe("set local role authenticated");
        await tx.unsafe("select save_github_connection(2, 'account-b', null, $1::bytea, null)", [
          await encryptSecret("refresh-b", key),
        ]);
      });
      // Reconnect must finish while GitHub is still held, not wait on an owner transaction.
      await reconnect;
      release();
      // The stale profile write is fenced by the refresh token that the request observed.
      expect(await first).toMatchObject({ status: "unavailable" });
      await reconnect;
      expect(
        Array.from(await observer.unsafe<{ login: string }[]>("select login from profile_changes")).map(
          (row) => row.login,
        ),
      ).toEqual(["account-b"]);
      const saved = await createSqlVaultStore(
        sqlOver({
          unsafe: (text, params) => one.unsafe(text, params),
          autonomous: (text, params) => observer.unsafe(text, params),
          begin: (work) => one.begin((tx) => work({ unsafe: (text, params) => tx.unsafe(text, params) })),
        }),
      ).getGitHubConnection(userId);
      expect(saved).toMatchObject({ githubId: 2, login: "account-b", accessTokenEnc: null, accessExpiresAt: null });
    } finally {
      release?.();
      await Promise.allSettled([one.end({ timeout: 1 }), two.end({ timeout: 1 }), observer.end({ timeout: 1 })]);
      await Promise.allSettled([first, reconnect].filter(Boolean));
      await admin.unsafe(`drop database ${name} with (force)`);
      await admin.end();
    }
  }, 60000);
});
