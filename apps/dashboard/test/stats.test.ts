import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { statsRoute } from "../src/lib/stats";

const TOKEN = "synthetic-stats-token";
const NOW = new Date("2026-04-10T12:00:00Z");
const db = new PGlite();
const get = (authorization?: string) =>
  new Request("https://dashboard.test/api/stats", {
    headers: authorization ? { authorization } : { cookie: "sb-project-auth-token=synthetic-session" },
  });
const deps = {
  token: TOKEN,
  accounts: async () => ({ client: db }),
  now: () => NOW,
};

beforeAll(async () => {
  await db.exec(`CREATE SCHEMA auth;
    CREATE TABLE auth.users (created_at timestamptz, email_confirmed_at timestamptz, last_sign_in_at timestamptz);
    INSERT INTO auth.users VALUES
      ('2026-04-10T11:00Z', '2026-04-10T11:00Z', '2026-04-10T11:00Z'),
      ('2026-04-09T12:00Z', '2026-04-09T12:00Z', '2026-04-09T12:00Z'),
      ('2026-04-03T12:00Z', '2026-04-03T12:00Z', '2026-04-03T12:00Z'),
      ('2026-03-01T12:00Z', '2026-03-01T12:00Z', '2026-03-01T12:00Z'),
      ('2026-03-01T12:00Z', '2026-03-01T12:00Z', NULL),
      ('2026-04-10T11:00Z', NULL, '2026-04-10T11:00Z');`);
});
afterAll(() => db.close());

test("correct bearer returns confirmed user counts with inclusive daily/weekly windows", async () => {
  const response = await statsRoute(get(`Bearer ${TOKEN}`), deps);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    total_users: 5,
    new_users_1d: 2,
    new_users_7d: 3,
    active_users_1d: 2,
    active_users_7d: 3,
  });
});

test("missing/wrong bearer or unconfigured token refuses access before opening the database, even with a cookie", async () => {
  let opened = false;
  const accounts = async () => {
    opened = true;
    return null;
  };
  for (const [token, authorization] of [
    [TOKEN, undefined],
    [TOKEN, "Bearer wrong"],
    [TOKEN, TOKEN],
    [TOKEN, `Bearer ${TOKEN}x`],
    [undefined, `Bearer ${TOKEN}`],
    ["", "Bearer"],
    ["  ", "Bearer"],
  ]) {
    const response = await statsRoute(get(authorization), { token, accounts });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  }
  expect(opened).toBe(false);
});

test("unconfigured database returns unknown counts", async () => {
  const response = await statsRoute(get(`Bearer ${TOKEN}`), { ...deps, accounts: async () => null });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    total_users: null,
    new_users_1d: null,
    new_users_7d: null,
    active_users_1d: null,
    active_users_7d: null,
  });
});

test("database errors return only a generic unavailable response", async () => {
  const response = await statsRoute(get(`Bearer ${TOKEN}`), {
    ...deps,
    accounts: async () => {
      throw new Error("synthetic database failure");
    },
  });
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "stats unavailable" });
});
