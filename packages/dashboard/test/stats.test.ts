import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { accountsGuard } from "../lib/accounts-http.ts";
import { guard } from "../lib/auth-http.ts";
import type { Database } from "../lib/db.ts";
import { statsRoute } from "../lib/stats.ts";
import { tempDatabase } from "./support.ts";

// Synthetic people and token, for these tests only.
const BASE = "http://localhost:4838";
const TOKEN = "synthetic-stats-token";
const NOW = new Date("2026-04-10T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600 * 1000);

let db: Database;

beforeAll(async () => {
  db = await tempDatabase();
  const user = (id: string, createdAt: Date, verified = true) =>
    db.query(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1, $2, $4, $3, $3)`,
      [id, `${id}@example.test`, createdAt, verified],
    );
  await user("ada", hoursAgo(2));
  await user("ben", hoursAgo(3 * 24));
  await user("cleo", hoursAgo(30 * 24));
  // An email sign-up never confirmed: it cannot sign in, so it is no user.
  await user("dana", hoursAgo(1), false);
  const visit = (viewer: string, organization: string, seenAt: Date) =>
    db.query(`INSERT INTO fleet_viewers (viewer, organization, seen_at) VALUES ($1, $2, $3)`, [
      viewer,
      organization,
      seenAt,
    ]);
  // Ada works in two organizations: one person, counted once.
  await visit("user:ada", "org-a", hoursAgo(1));
  await visit("user:ada", "org-b", hoursAgo(5));
  await visit("user:ben", "org-a", hoursAgo(4 * 24));
  await visit("user:cleo", "org-a", hoursAgo(20 * 24));
  // A browser under the shared-password gate is no account.
  await visit("browser:synthetic-browser-id", "", hoursAgo(1));
});

afterAll(async () => {
  await db.end();
});

const get = (authorization?: string) =>
  new Request(`${BASE}/api/stats`, { headers: authorization ? { authorization } : {} });

describe("GET /api/stats", () => {
  const deps = (token: string | undefined) => ({ token, accounts: async () => ({ client: db }), now: () => NOW });

  test("answers the counts to the right token, from accounts and their visits", async () => {
    const res = await statsRoute(get(`Bearer ${TOKEN}`), deps(TOKEN));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      total_users: 3,
      new_users_1d: 1,
      new_users_7d: 2,
      active_users_1d: 1,
      active_users_7d: 2,
    });
  });

  test("refuses a missing or wrong token, and every request while STATS_TOKEN is unset or empty", async () => {
    expect((await statsRoute(get(`Bearer ${TOKEN}`), deps(TOKEN))).status).toBe(200);
    for (const authorization of [undefined, "Bearer wrong-token", TOKEN, `Bearer ${TOKEN}x`]) {
      const res = await statsRoute(get(authorization), deps(TOKEN));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    for (const token of [undefined, "", "  "])
      for (const authorization of [undefined, "Bearer ", `Bearer ${token ?? ""}`])
        expect((await statsRoute(get(authorization), deps(token))).status).toBe(401);
  });

  test("answers null for every number while the dashboard has no accounts", async () => {
    const res = await statsRoute(get(`Bearer ${TOKEN}`), { token: TOKEN, accounts: async () => null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      total_users: null,
      new_users_1d: null,
      new_users_7d: null,
      active_users_1d: null,
      active_users_7d: null,
    });
  });

  test("passes both proxy gates without a session, as a GET only: the route checks its own token", async () => {
    const request = (method: string) => new NextRequest(`${BASE}/api/stats`, { method });
    const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";
    const password = { env: { NODE_ENV: "production", ARMADA_DASHBOARD_PASSWORD: "synthetic" }, now: NOW.getTime() };
    const accounts = { env: {}, session: async () => "none" as const };
    expect(passed(guard(request("GET"), password))).toBe(true);
    expect(passed(await accountsGuard(request("GET"), accounts))).toBe(true);
    expect(guard(request("POST"), password).status).toBe(401);
    expect((await accountsGuard(request("POST"), accounts)).status).toBe(401);
  });
});
