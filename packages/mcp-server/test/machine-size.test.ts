import { expect, test } from "bun:test";
import { createSqlGoldenStore, createSqlVaultStore, parseGoldenConfig } from "@armada/core";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { call, ENCRYPTION_KEY, harness, PUBLIC_URL } from "./support.ts";

test("size policies use live org admin/private owner authority, persist without provider work, and validate repository identity", async () => {
  const server = await harness();
  try {
    const { db, people } = server;
    const control = {
      authStore: server.auth,
      supabase: { supabaseUrl: "https://unused.test", anonKey: "test" },
      store: createSqlVaultStore(db),
      encryptionKey: ENCRYPTION_KEY,
      data: createSqlData(db),
      providerFor: server.boat.providerFor,
    };
    const policy = { version: 1, golden: "medium", repositories: { web: "large" } };
    const request = async (user: string, golden: string, value: unknown) =>
      handleControlRequest(
        new Request(`${PUBLIC_URL}/api/v1/golden/size-policy`, {
          method: "POST",
          headers: { authorization: `Bearer ${await server.token(user)}` },
          body: JSON.stringify({ golden, org: people.org, policy: value }),
        }),
        control,
      );
    expect((await request(people.member, "shared", policy))?.status).toBe(403);
    expect([403, 404]).toContain((await request(people.admin, "mine", policy))?.status ?? 0);
    expect((await request(people.admin, "shared", { ...policy, repositories: { missing: "large" } }))?.status).toBe(
      400,
    );
    expect((await request(people.admin, "shared", policy))?.status).toBe(200);
    const member = await server.client(await server.token(people.member));
    const read = await call(member, "golden_size_policy", { golden: "shared", org: people.org });
    expect(read.isError).not.toBe(true);
    expect(JSON.stringify(read)).toContain('"medium"');
    const denied = await call(member, "golden_size_policy", { golden: "shared", org: people.org, policy });
    expect(denied.isError).toBe(true);
    const launched = await call(member, "launch", {
      golden: "shared",
      org: people.org,
      harness: "claude",
      size: "small",
    });
    expect(launched.isError).not.toBe(true);
    expect(server.boat.forks[0]?.size).toBe("small");
    const row = (await db.query<{ machine_size: unknown }>("select machine_size from sandboxes")).rows[0];
    expect(row?.machine_size).toMatchObject({
      requested: "small",
      effective: "small",
      source: "override",
      capacity: { provider: "boat", vcpus: 2, memoryMiB: 4096, provenance: "requested-provider-resources" },
    });
    await expect(db.query("update sandboxes set machine_size=null")).rejects.toThrow("immutable");
    await db.query("update members set role='admin' where user_id=$1", [people.member]);
    await db.query("update members set role='member' where user_id=$1", [people.admin]);
    expect((await request(people.admin, "shared", policy))?.status).toBe(403);
    expect(server.boat.forks).toHaveLength(1);
    const store = createSqlGoldenStore(db);
    const golden = (await store.findByName(people.org, "shared"))[0];
    if (!golden) throw new Error("missing shared golden");
    await store.setConfig(
      golden.id,
      parseGoldenConfig({ repos: [{ url: "https://github.com/acme/new.git", dir: "new" }], init: [] }),
    );
    const scoped = createSqlData(db)({
      userId: people.member,
      via: "service",
      orgs: [{ orgId: people.org, role: "admin" }],
    });
    await expect(
      scoped.goldens.setSizePolicy?.(
        golden,
        { userId: people.member, orgId: people.org, role: "admin" },
        {
          version: 1,
          golden: "small",
          repositories: { web: "large" },
        },
      ),
    ).rejects.toThrow("cannot change");
    const updated = (await store.findByName(people.org, "shared"))[0];
    expect(updated?.sizePolicy).toEqual({ version: 1, golden: "medium", repositories: {} });
    expect(updated?.config.repos[0]?.dir).toBe("new");
  } finally {
    await server.close();
  }
});
