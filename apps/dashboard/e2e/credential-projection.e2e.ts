import { expect, test } from "@playwright/test";
import { MOCK, reset } from "./helpers";

test.beforeEach(reset);

test("credentials reads enforce column grants even when no rows match", async ({ request }) => {
  const login = await request.post(`${MOCK}/auth/v1/verify`, {
    data: { email: "alice@example.com", token: "123456", type: "email" },
  });
  expect(login.status()).toBe(200);
  const { access_token } = await login.json();
  const headers = { authorization: `Bearer ${access_token}` };

  // The migration-backed permission owner is core/test/database.test.ts:
  // authenticated users may read metadata, never credentials.value_enc.
  for (const filter of ["", "&id=eq.00000000-0000-4000-8000-999999999999"]) {
    for (const selection of [
      "",
      "&select=",
      "&select=*",
      "&select=id,*",
      "&select=value_enc",
      "&select=id,value_enc",
    ]) {
      const response = await request.get(`${MOCK}/rest/v1/credentials?${selection}${filter}`, { headers });
      expect(response.status(), `${selection || "absent select"}${filter}`).toBe(401);
      expect(await response.json()).toMatchObject({
        code: "42501",
        message: "permission denied for table credentials",
      });
    }
  }

  const columns = "id,scope,owner_id,kind,created_at,name,is_default,status,expires_at,updated_at,version";
  const allowed = await request.get(`${MOCK}/rest/v1/credentials?select=${columns}`, { headers });
  expect(allowed.status()).toBe(200);
  const rows = await allowed.json();
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row).toHaveProperty("id");
    expect(row).toHaveProperty("kind");
    expect(row).not.toHaveProperty("value_enc");
  }
  const empty = await request.get(
    `${MOCK}/rest/v1/credentials?select=${columns}&id=eq.00000000-0000-4000-8000-999999999999`,
    { headers },
  );
  expect(empty.status()).toBe(200);
  expect(await empty.json()).toEqual([]);
});
