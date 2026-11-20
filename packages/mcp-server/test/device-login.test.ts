import { afterAll, beforeAll, expect, test } from "bun:test";
import { createMemoryAuthStore, sha256Hex } from "@armada/auth";
import { publicAuthOperations } from "@armada/core/contract";
import { PGlite } from "@electric-sql/pglite";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { deviceLoginFromConfig } from "../src/device-login-control.ts";

const db = new PGlite();
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "person@example.test",
  email_confirmed_at: "confirmed",
};
const { authDeviceStart, authDeviceInspect, authDeviceDecide, authDevicePoll } = publicAuthOperations;

beforeAll(async () => {
  await db.exec(`
    create schema armada_auth;
    create table armada_auth.oauth_device_requests (
      id uuid primary key, device_hash text unique, user_code text, hostname text,
      created_at timestamptz, expires_at timestamptz, next_poll_at timestamptz,
      poll_interval int default 5, state text default 'pending', user_id uuid
    );
  `);
});
afterAll(async () => db.close());

const sessionCalls: string[] = [];
const options: ControlOptions = {
  store: {} as ControlOptions["store"],
  encryptionKey: undefined,
  authStore: createMemoryAuthStore(),
  deviceLogin: deviceLoginFromConfig(db, "https://dashboard.test", "admin-fixture")!,
  supabase: {
    supabaseUrl: "https://supabase.test",
    anonKey: "anon-fixture",
    fetch: async (input, init) => {
      switch (new URL(String(input)).pathname) {
        case "/auth/v1/user":
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer dashboard.browser.session");
          return Response.json(user);
        case `/auth/v1/admin/users/${user.id}`:
          return Response.json(user);
        case "/auth/v1/admin/generate_link":
          sessionCalls.push("generate");
          expect(JSON.parse(String(init?.body))).toEqual({ type: "magiclink", email: user.email });
          return Response.json({ id: user.id, hashed_token: "link-fixture" });
        case "/auth/v1/verify":
          sessionCalls.push("verify");
          expect(JSON.parse(String(init?.body))).toEqual({ type: "email", token_hash: "link-fixture" });
          return Response.json({ user, access_token: "cli-access", refresh_token: "cli-refresh", expires_in: 3600 });
        default:
          throw new Error("Unexpected upstream request");
      }
    },
  },
};

async function post(path: string, body: unknown, signedIn = false) {
  const response = await handleControlRequest(
    new Request(new URL(path, "https://armada.test").href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signedIn ? { authorization: "Bearer dashboard.browser.session" } : {}),
      },
      body: JSON.stringify(body),
    }),
    options,
  );
  if (!response) throw new Error("Device route is missing");
  return response;
}

async function start() {
  const response = await post(authDeviceStart.route.path, { hostname: "ssh-host" });
  const started = authDeviceStart.output.parse(await response.json());
  const url = new URL(started.verification_uri_complete);
  expect(url.origin).toBe("https://dashboard.test");
  expect(url.href).not.toContain(started.device_code);
  return {
    id: url.searchParams.get("id"),
    user_code: started.user_code,
    device_code: started.device_code,
  };
}

async function poll(device_code: string) {
  const response = await post(authDevicePoll.route.path, { device_code });
  return authDevicePoll.output.parse(await response.json());
}

test("dashboard consent binds the user and concurrent CLI polls deliver just one independent session", async () => {
  const { id, user_code, device_code } = await start();
  const hash = await sha256Hex(device_code);
  expect(
    (await db.query("select device_hash from armada_auth.oauth_device_requests where id = $1", [id])).rows,
  ).toEqual([{ device_hash: hash }]);
  const inspect = await post(authDeviceInspect.route.path, { id }, true);
  expect(authDeviceInspect.output.parse(await inspect.json())).toEqual({ user_code, hostname: "ssh-host" });
  const approve = { id, user_code, approve: true };
  expect((await post(authDeviceDecide.route.path, approve)).status).toBe(401);
  expect(
    (
      await post(
        authDeviceDecide.route.path,
        { ...approve, user_code: user_code === "FFFFFFFF" ? "EEEEEEEE" : "FFFFFFFF" },
        true,
      )
    ).status,
  ).toBe(404);
  expect(await poll(device_code)).toEqual({ status: "slow_down", interval: 10 });
  await db.query("update armada_auth.oauth_device_requests set next_poll_at = '-infinity' where id = $1", [id]);
  expect(await poll(device_code)).toEqual({ status: "authorization_pending", interval: 10 });
  const decision = await post(authDeviceDecide.route.path, approve, true);
  expect(authDeviceDecide.output.parse(await decision.json())).toEqual({ ok: true });
  expect((await post(authDeviceDecide.route.path, { ...approve, approve: false }, true)).status).toBe(404);
  await db.query("update armada_auth.oauth_device_requests set next_poll_at = '-infinity' where id = $1", [id]);
  const results = await Promise.all([poll(device_code), poll(device_code)]);
  expect(results.map(({ status }) => status).sort()).toEqual(["authorized", "expired_token"]);
  expect(results.find(({ status }) => status === "authorized")).toMatchObject({
    accessToken: "cli-access",
    refreshToken: "cli-refresh",
    email: user.email,
  });
  expect(sessionCalls).toEqual(["generate", "verify"]);
});

test("denial ends the device login", async () => {
  const { id, user_code, device_code } = await start();
  expect((await post(authDeviceDecide.route.path, { id, user_code, approve: false }, true)).status).toBe(200);
  expect(await poll(device_code)).toEqual({ status: "access_denied" });
});

test("expired requests cannot be inspected, approved or redeemed", async () => {
  const { id, user_code, device_code } = await start();
  await db.query("update armada_auth.oauth_device_requests set expires_at = '-infinity' where id = $1", [id]);
  expect((await post(authDeviceInspect.route.path, { id }, true)).status).toBe(404);
  expect((await post(authDeviceDecide.route.path, { id, user_code, approve: true }, true)).status).toBe(404);
  expect(await poll(device_code)).toEqual({ status: "expired_token" });
});
