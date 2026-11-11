import { expect, test } from "bun:test";
import { createSqlGoldenStore, parseGoldenConfig } from "@armada/core";
import { createSqlVaultStore } from "@armada/core/server";
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

test("versioned launch enforces sizing before allocation and shares override/default resolution without breaking legacy launch", async () => {
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
    const token = await server.token(people.member);
    const launch = async (body: Record<string, unknown>, route = "sandbox/launch-sized-v1") =>
      handleControlRequest(
        new Request(`${PUBLIC_URL}/api/v1/${route}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ golden: "shared", harness: "claude", ...body }),
        }),
        control,
      );
    for (const body of [
      { size: "small" },
      { sizePolicyVersion: 2, size: "small" },
      { sizePolicyVersion: 1, size: "invalid" },
    ]) {
      expect((await launch(body))?.status).toBe(400);
      expect(server.boat.forks).toHaveLength(0);
    }
    await db.query(`update goldens set size_policy=$1::jsonb where name='shared'`, [
      JSON.stringify({ version: 1, golden: "large", repositories: {} }),
    ]);
    const sized = await launch({ sizePolicyVersion: 1, size: "small" });
    expect(sized?.status).toBe(200);
    expect(await sized?.json()).toMatchObject({
      sandbox: {
        machineSize: {
          requested: "small",
          effective: "small",
          source: "override",
        },
      },
    });
    const defaults = await launch({ sizePolicyVersion: 1 });
    expect(defaults?.status).toBe(200);
    expect(await defaults?.json()).toMatchObject({
      sandbox: {
        machineSize: {
          requested: null,
          effective: "large",
          source: "golden",
        },
      },
    });
    const client = await server.client(token);
    const invalid = await call(client, "launch_sized_v1", { golden: "shared", harness: "claude", size: "small" });
    expect(invalid.isError).toBe(true);
    expect(server.boat.forks).toHaveLength(2);
    const mcp = await call(client, "launch_sized_v1", {
      golden: "shared",
      harness: "claude",
      size_policy_version: 1,
      size: "medium",
    });
    expect(mcp.isError).not.toBe(true);
    expect(server.boat.forks.at(-1)?.size).toBe("medium");
    const legacy = await launch({}, "sandbox/launch");
    expect(legacy?.status).toBe(200);
    expect(server.boat.forks).toHaveLength(4);
  } finally {
    await server.close();
  }
});
