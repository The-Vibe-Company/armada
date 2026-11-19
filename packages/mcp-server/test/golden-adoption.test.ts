import { expect, test } from "bun:test";
import { createSqlVaultStore } from "@armada/core/server";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { ENCRYPTION_KEY, harness, PUBLIC_URL } from "./support.ts";

test("REST adoption reject hidden ids and visible non-admin selection before provider access", async () => {
  let attempts = 0;
  const goldenAdoption = async () => {
    attempts++;
    throw new Error("must not adopt");
  };
  const server = await harness();
  try {
    const token = await server.token(server.people.member);
    const rows = await server.db.query<{ id: string; name: string }>(
      "select id,name from goldens where name in ('shared','mine')",
    );
    const control: ControlOptions = {
      authStore: server.auth,
      supabase: { supabaseUrl: "https://unused.test", anonKey: "test" },
      store: createSqlVaultStore(server.db),
      encryptionKey: ENCRYPTION_KEY,
      data: createSqlData(server.db),
      providers: {
        resolve: async () => {
          attempts++;
          throw new Error("must not resolve");
        },
      },
      goldenAdoption,
    };
    for (const { id, status } of [
      ...rows.rows.map((row) => ({ id: row.id, status: row.name === "shared" ? 403 : 404 })),
      { id: "99999999-9999-4999-8999-999999999999", status: 404 },
    ]) {
      const response = await handleControlRequest(
        new Request(PUBLIC_URL + "/api/v1/golden/adopt", {
          method: "POST",
          headers: { authorization: "Bearer " + token },
          body: JSON.stringify({ id }),
        }),
        control,
      );
      expect(response?.status).toBe(status);
      const text = await response!.text();
      expect(text).not.toContain("mine");
      expect(text).not.toContain("backend_id");
    }
    const unauthorized = await handleControlRequest(
      new Request(PUBLIC_URL + "/api/v1/golden/adopt", {
        method: "POST",
        body: JSON.stringify({ id: rows.rows[0]?.id }),
      }),
      control,
    );
    expect(unauthorized?.status).toBe(401);
    expect(attempts).toBe(0);
  } finally {
    await server.close();
  }
});

test("REST adoption passes the scoped golden, actor and confirmation to the adoption service", async () => {
  const server = await harness();
  try {
    const { auth, boat, db, people } = server;
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!;
    const token = await server.token(people.admin);
    const receipt = crypto.randomUUID();
    const control: ControlOptions = {
      authStore: auth,
      supabase: { supabaseUrl: "https://unused.test", anonKey: "test" },
      store: createSqlVaultStore(db),
      encryptionKey: ENCRYPTION_KEY,
      data: createSqlData(db),
      providers: { resolve: async () => boat.provider },
      goldenAdoption: async (provider, actor, target, confirmation) => {
        expect(provider).toBe(boat.provider);
        expect(actor).toEqual({ userId: people.admin, orgId: people.org, role: "admin" });
        expect(target.id).toBe(golden.id);
        return { goldenId: target.id, dryRun: confirmation === undefined, confirmation: confirmation ?? receipt };
      },
    };
    for (const confirmation of [undefined, receipt]) {
      const response = await handleControlRequest(
        new Request(PUBLIC_URL + "/api/v1/golden/adopt", {
          method: "POST",
          headers: { authorization: "Bearer " + token },
          body: JSON.stringify({ id: golden.id, org: people.org, confirmation }),
        }),
        control,
      );
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({
        goldenId: golden.id,
        dryRun: confirmation === undefined,
        confirmation: receipt,
      });
    }
  } finally {
    await server.close();
  }
});
