import { expect, test } from "bun:test";
import { createSqlVaultStore } from "@armada/core";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { call, ENCRYPTION_KEY, harness, PUBLIC_URL } from "./support.ts";

test("HTTP and MCP adoption reject hidden ids and visible non-admin selection before provider access", async () => {
  let attempts = 0;
  const goldenAdoption = async () => {
    attempts++;
    throw new Error("must not adopt");
  };
  const server = await harness({ goldenAdoption });
  try {
    const token = await server.token(server.people.member);
    const client = await server.client(token);
    const rows = await server.db.query<{ id: string }>("select id from goldens where name in ('shared','mine')");
    const control = {
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
    for (const id of [...rows.rows.map((row) => row.id), "99999999-9999-4999-8999-999999999999"]) {
      const result = await call(client, "golden_adopt", { id });
      expect(result.isError).toBe(true);
      const response = await handleControlRequest(
        new Request(PUBLIC_URL + "/api/v1/golden/adopt", {
          method: "POST",
          headers: { authorization: "Bearer " + token },
          body: JSON.stringify({ id }),
        }),
        control,
      );
      expect(response?.status).toBe(400);
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
