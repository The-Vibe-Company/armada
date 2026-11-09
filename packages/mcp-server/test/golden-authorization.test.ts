import { expect, test } from "bun:test";
import { createSqlVaultStore } from "@armada/core";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { call, ENCRYPTION_KEY, harness, PUBLIC_URL } from "./support.ts";

test("HTTP and MCP reject golden mutations before resolving a provider or invoking the builder", async () => {
  const server = await harness();
  try {
    const { db, people, boat } = server;
    await db.query("update goldens set provider_sandbox_id = 'master-' || id::text");
    const before = (
      await db.query(
        "select id, owner_id, visibility, provider_sandbox_id, provider_snapshot_id, config from goldens order by id",
      )
    ).rows;
    const control = {
      authStore: server.auth,
      supabase: {
        supabaseUrl: "https://unused.test",
        anonKey: "test",
        fetch: async () => {
          throw new Error("service token must not use Supabase");
        },
      },
      store: createSqlVaultStore(db),
      encryptionKey: ENCRYPTION_KEY,
      data: createSqlData(db),
      providerFor: boat.providerFor,
      goldenBuilds: server.builds,
    };
    for (const [user, name, org] of [
      [people.member, "shared", people.org], // visible but not mutable
      [people.admin, "mine", people.org], // admin is not private owner
      [people.owner, "elsewhere", people.otherOrg], // outside scoped token
    ] as const) {
      const token = await server.token(user);
      const client = await server.client(token);
      for (const operation of ["snapshot", "update", "create", "connect"]) {
        if (operation === "create" && name !== "shared") continue;
        const response = await handleControlRequest(
          new Request(`${PUBLIC_URL}/api/v1/golden/${operation}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({
              name,
              idempotencyKey: crypto.randomUUID(),
              org,
              repos: ["acme/web"],
              config: { repos: [{ url: "https://github.com/acme/web.git" }], init: [] },
            }),
          }),
          control,
        );
        expect([403, 404]).toContain(response?.status ?? 0);
        if (operation !== "connect") {
          const result = await call(client, `golden_${operation}`, {
            name,
            org,
            repos: ["acme/web"],
            idempotencyKey: crypto.randomUUID(),
          });
          expect(result.isError).toBe(true);
        }
      }
    }
    expect(boat.keys.length).toBe(0);
    expect(boat.execs).toEqual([]);
    expect(boat.forks).toEqual([]);
    expect((await db.query("select 1 from golden_build_jobs")).rows).toEqual([]);
    expect(
      (
        await db.query(
          "select id, owner_id, visibility, provider_sandbox_id, provider_snapshot_id, config from goldens order by id",
        )
      ).rows,
    ).toEqual(before);
  } finally {
    await server.close();
  }
});

test("authorized HTTP connect and snapshot reject unbound, wrong-account and busy slots without provider work", async () => {
  const server = await harness();
  try {
    const { db, people } = server;
    const token = await server.token(people.admin);
    const golden = (await db.query<{ id: string }>("select id from goldens where name = 'shared'")).rows[0];
    if (!golden) throw new Error("missing fixture");
    let work = 0;
    const provider = new Proxy(
      {
        id: "boat",
        backendIdentity: async () => ({ id: "account-A" }),
        get: async () => {
          work++;
          return { id: "master", state: "ready" };
        },
        exec: async () => {
          work++;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        snapshot: async ({ name }: { name: string }) => {
          work++;
          return { name, status: "ready" };
        },
      },
      {
        get(target, key) {
          if (key === "then") return undefined;
          if (key in target) return target[key as keyof typeof target];
          return async () => {
            work++;
            throw new Error("unexpected provider work");
          };
        },
      },
    );
    const options = {
      authStore: server.auth,
      supabase: {
        supabaseUrl: "https://unused.test",
        anonKey: "test",
        fetch: async () => {
          throw new Error("service token must not use Supabase");
        },
      },
      store: createSqlVaultStore(db),
      encryptionKey: ENCRYPTION_KEY,
      data: createSqlData(db),
      providerFor: () => provider as never,
    };
    for (const state of ["unbound", "wrong-account", "busy"]) {
      if (state !== "unbound")
        await db.query(
          `insert into golden_backend_slots(provider, backend_id, max_goldens, org_id, owner_id, golden_id, build_id)
        values ('boat', $1, 1, $2, $3, $4, $5)`,
          [
            state === "wrong-account" ? "account-B" : "account-A",
            people.org,
            people.admin,
            golden.id,
            state === "busy" ? crypto.randomUUID() : null,
          ],
        );
      for (const op of ["connect", "snapshot"]) {
        const response = await handleControlRequest(
          new Request(`${PUBLIC_URL}/api/v1/golden/${op}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ name: "shared" }),
          }),
          options,
        );
        expect(response?.status).toBe(409);
        const body = await response?.text();
        expect(body).toContain('"code":"conflict"');
        expect(body).not.toContain("account-A");
        expect(body).not.toContain("account-B");
      }
      await db.query("delete from golden_backend_slots");
    }
    expect(work).toBe(0);
    await db.query("update goldens set provider_sandbox_id = 'master' where id = $1", [golden.id]);
    await db.query(
      `insert into golden_backend_slots(provider, backend_id, max_goldens, org_id, owner_id, golden_id)
      values ('boat', 'account-A', 1, $1, $2, $3)`,
      [people.org, people.admin, golden.id],
    );
    for (const op of ["connect", "snapshot"]) {
      const response = await handleControlRequest(
        new Request(`${PUBLIC_URL}/api/v1/golden/${op}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: "shared" }),
        }),
        options,
      );
      expect(response?.status).toBe(200);
    }
    expect(work).toBeGreaterThan(0);
    expect(
      (
        await db.query<{ snapshot: string }>("select provider_snapshot_id as snapshot from goldens where id = $1", [
          golden.id,
        ])
      ).rows[0]?.snapshot,
    ).toBeTruthy();
  } finally {
    await server.close();
  }
});
