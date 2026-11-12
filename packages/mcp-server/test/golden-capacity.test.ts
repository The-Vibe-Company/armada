import { expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import { createSqlVaultStore } from "@armada/core/server";
import { sqlGoldenBackendSlots } from "../../core/src/golden-create.ts";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { call, ENCRYPTION_KEY, harness, PUBLIC_URL } from "./support.ts";

test("HTTP and MCP report real capacity, pending, busy and binding conflicts without allocating or leaking", async () => {
  let sql: Sql;
  let allocations = 0;
  const account = "backend-hidden-account";

  const server = await harness();
  sql = server.db;
  try {
    const { db, people, boat } = server;
    boat.provider.backendIdentity = async () => ({ id: account });
    boat.provider.createGolden = async () => {
      allocations++;
      throw new Error("must not allocate");
    };
    const control = {
      authStore: server.auth,
      supabase: { supabaseUrl: "https://unused.test", anonKey: "test" },
      store: createSqlVaultStore(db),
      encryptionKey: ENCRYPTION_KEY,
      data: createSqlData(db),
      providerFor: boat.providerFor,
      goldenBuilds: server.builds,
    };
    const rows = await db.query<{ id: string; name: string }>("select id,name from goldens");
    const shared = rows.rows.find((row) => row.name === "shared")!;
    const hidden = rows.rows.find((row) => row.name === "mine")!;
    await db.query("insert into members(org_id,user_id,role) values ($1,$2,'member')", [people.otherOrg, people.owner]);
    const goldensBefore = (await db.query("select * from goldens order by id")).rows;
    const request = async (user: string, org: string, isPrivate: boolean, operation = "create") => {
      const token = await server.token(user, org);
      const name = operation === "update" ? "shared" : "quota-probe";
      const body = {
        name,
        idempotencyKey: crypto.randomUUID(),
        org,
        private: isPrivate,
        repos: ["acme/web"],
        ...(operation === "update"
          ? { config: { repos: [{ url: "https://github.com/acme/web.git" }], init: [] } }
          : {}),
      };
      const [http, mcp] = await Promise.all([
        handleControlRequest(
          new Request(PUBLIC_URL + "/api/v1/golden/" + operation, {
            method: "POST",
            headers: { authorization: "Bearer " + token },
            body: JSON.stringify(body),
          }),
          control,
        ),
        server.client(token).then((client) => call(client, "golden_" + operation, body)),
      ]);
      expect(http?.status).toBe(409);
      const json = (await http!.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe("conflict");
      expect(json.error.message).toContain("Use an existing golden you can access");
      expect(mcp.isError).toBe(true);
      expect(mcp.text).toContain("error code: conflict");
      expect(mcp.text).toContain(json.error.message);
      for (const value of [account, hidden.id, "mine", people.owner, "golden_backend_slots", "23505", "P0001"]) {
        expect(JSON.stringify(json)).not.toContain(value);
        expect(mcp.text).not.toContain(value);
      }
      expect(allocations).toBe(0);
      expect((await db.query("select * from goldens order by id")).rows).toEqual(goldensBefore);
    };
    // An invisible private binding fills the account across org/private and cross-org scopes.
    await db.query(
      `insert into golden_backend_slots(provider,backend_id,max_goldens,org_id,owner_id,golden_id)
      values('boat',$1,1,$2,$3,$4)`,
      [account, people.org, people.owner, hidden.id],
    );
    const ready = (await db.query("select * from golden_backend_slots")).rows;
    for (const [user, org, privateFlag] of [
      [people.admin, people.org, false],
      [people.owner, people.org, true],
      [people.owner, people.otherOrg, true],
    ] as const)
      await request(user, org, privateFlag);
    expect((await db.query("select * from golden_backend_slots")).rows).toEqual(ready);
    // The database unique-account constraint, not just the count guard.
    Object.defineProperty(boat.provider, "maxGoldens", { value: 2, configurable: true });
    await request(people.admin, people.org, false);
    expect((await db.query("select * from golden_backend_slots")).rows).toEqual(ready);
    Object.defineProperty(boat.provider, "maxGoldens", { value: 1, configurable: true });
    await db.query("delete from golden_backend_slots");
    const pending = await sqlGoldenBackendSlots(sql).reserve({
      provider: "boat",
      backendId: account,
      capacity: 1,
      orgId: people.org,
      ownerId: people.admin,
    });
    await request(people.admin, people.org, false);
    expect((await db.query<{ build_id: string }>("select build_id from golden_backend_slots")).rows).toEqual([
      { build_id: pending },
    ]);
    await sqlGoldenBackendSlots(sql).release(pending);
    // Exercise a reservation race after a caller's binding precheck: busy existing binding.
    await db.query(
      `insert into golden_backend_slots(provider,backend_id,max_goldens,org_id,owner_id,golden_id,build_id)
      values('boat',$1,1,$2,$3,$4,$5)`,
      [account, people.org, people.admin, shared.id, crypto.randomUUID()],
    );
    const busy = (await db.query("select * from golden_backend_slots")).rows;
    await request(people.admin, people.org, false, "update");
    expect((await db.query("select * from golden_backend_slots")).rows).toEqual(busy);
    await db.query("delete from golden_backend_slots");
    // A binding changed to a different account between precheck and reservation.
    await db.query(
      `insert into golden_backend_slots(provider,backend_id,max_goldens,org_id,owner_id,golden_id)
      values('boat','another-hidden-account',1,$1,$2,$3)`,
      [people.org, people.admin, shared.id],
    );
    const binding = (await db.query("select * from golden_backend_slots")).rows;
    await request(people.admin, people.org, false, "update");
    expect((await db.query("select * from golden_backend_slots")).rows).toEqual(binding);
  } finally {
    await server.close();
  }
});

test("unexpected SQL and provider failures stay server errors rather than becoming capacity conflicts", async () => {
  let underlying: Sql;
  let failure = "raise";
  let allocations = 0;
  const sql: Sql = {
    transaction: (work) => work(sql),
    query: async (query, params) => {
      if (failure === "raise")
        return underlying.query("do $$ begin raise exception 'unexpected database failure'; end $$");
      if (failure === "unique") return underlying.query("insert into orgs(id,name) select id,name from orgs limit 1");
      if (failure === "sql") return underlying.query("select 1/0");
      return underlying.query(query, params);
    },
  };

  const server = await harness({
    sql: (db) => {
      underlying = db;
      return sql;
    },
  });
  try {
    const { db, boat, people } = server;
    boat.provider.createGolden = async () => {
      allocations++;
      throw new Error("must not allocate");
    };
    boat.provider.backendIdentity = async () => {
      // Even a provider exception resembling the database's known raise must not be translated.
      if (failure === "provider") throw Object.assign(new Error("golden backend capacity reached"), { code: "P0001" });
      return { id: "account" };
    };
    const token = await server.token(people.admin);
    const client = await server.client(token);
    const control = {
      authStore: server.auth,
      supabase: { supabaseUrl: "https://unused.test", anonKey: "test" },
      store: createSqlVaultStore(db),
      encryptionKey: ENCRYPTION_KEY,
      providerFor: boat.providerFor,
      goldenBuilds: server.builds,
    };
    for (failure of ["raise", "unique", "sql", "provider"]) {
      const body = { idempotencyKey: crypto.randomUUID(), name: "quota-probe", org: people.org, repos: ["acme/web"] };
      const response = await handleControlRequest(
        new Request(PUBLIC_URL + "/api/v1/golden/create", {
          method: "POST",
          headers: { authorization: "Bearer " + token },
          body: JSON.stringify(body),
        }),
        control,
      );
      expect(response?.status).toBe(500);
      expect(await response!.json()).toEqual({
        error: { code: "internal", message: "The server could not complete the request." },
      });
      const mcp = await call(client, "golden_create", body);
      expect(mcp.isError).toBe(true);
      expect(mcp.text).toContain("error code: internal");
      expect(mcp.text).not.toContain("unexpected database failure");
      expect(mcp.text).not.toContain("golden backend capacity reached");
    }
    expect(allocations).toBe(0);
    expect((await db.query("select * from golden_backend_slots")).rows).toHaveLength(0);
    expect((await db.query("select * from goldens")).rows).toHaveLength(3);
  } finally {
    await server.close();
  }
});
