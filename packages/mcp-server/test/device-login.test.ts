import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createMemoryAuthStore, sha256Hex } from "@armada/auth";
import { deviceConsentMessage, publicAuthOperations } from "@armada/core/contract";
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
      poll_interval int default 5, state text default 'pending', user_id uuid, oauth_code_enc bytea
    );
  `);
});
afterAll(async () => db.close());

const consentKey = "a".repeat(64);
const authorization = "Bearer dashboard.browser.session";

const clientId = "cli-client";
const requests = new Map<string, URLSearchParams>();
const sessions = new Map<string, string>();
let emailCode = "";
const issue = (id: string) => {
  const refresh_token = crypto.randomUUID();
  sessions.set(refresh_token, id);
  return Response.json({ access_token: id, refresh_token, expires_in: 3600 });
};

const options: ControlOptions = {
  store: {} as ControlOptions["store"],
  encryptionKey: btoa("k".repeat(32)),
  authStore: createMemoryAuthStore(),
  deviceLogin: deviceLoginFromConfig(db, "https://dashboard.test", {
    ARMADA_CLI_CONSENT_KEY: consentKey,
    ARMADA_CLI_OAUTH_CLIENT_ID: clientId,
    ARMADA_CLI_OAUTH_CLIENT_SECRET: "oauth-fixture",
  })!,
  supabase: {
    supabaseUrl: "https://supabase.test",
    anonKey: "anon-fixture",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const bearer = new Headers(init?.headers).get("authorization");
      if (path.startsWith("/auth/v1/oauth/authorizations/")) {
        expect(bearer).toBe(authorization);
        const id = path.split("/")[5]!;
        const query = requests.get(id)!;
        if (init?.method !== "POST") {
          return Response.json({ user, client: { id: clientId }, redirect_uri: query.get("redirect_uri") });
        }
        expect(JSON.parse(String(init.body))).toEqual({ action: "approve" });
        const callback = new URL(query.get("redirect_uri")!);
        callback.searchParams.set("code", id);
        callback.searchParams.set("state", query.get("state")!);
        return Response.json({ redirect_url: callback.href });
      }
      switch (path) {
        case "/auth/v1/user":
          if (bearer !== authorization && ![...sessions.values()].some((id) => bearer === `Bearer ${id}`)) {
            return new Response(null, { status: 401 });
          }
          return Response.json(user);
        case `/auth/v1/admin/users/${user.id}`:
          return Response.json(user);
        case "/auth/v1/admin/generate_link":
          emailCode = crypto.randomUUID();
          return Response.json({ id: user.id, hashed_token: emailCode });
        case "/auth/v1/otp":
          emailCode = "123456";
          return new Response(null, { status: 204 });
        case "/auth/v1/verify": {
          const { token, token_hash } = JSON.parse(String(init?.body));
          if (!emailCode || (token ?? token_hash) !== emailCode) return new Response(null, { status: 403 });
          emailCode = "";
          return Response.json({
            user,
            access_token: "email-access",
            refresh_token: "email-refresh",
            expires_in: 3600,
          });
        }
        case "/auth/v1/oauth/authorize": {
          const id = crypto.randomUUID();
          requests.set(id, url.searchParams);
          return Response.redirect(`https://dashboard.test/oauth/consent?authorization_id=${id}`);
        }
        case "/auth/v1/oauth/token": {
          const form = init?.body as URLSearchParams;
          expect(form.get("client_id")).toBe(clientId);
          if (form.get("grant_type") === "refresh_token") {
            const refresh = form.get("refresh_token")!;
            const id = sessions.get(refresh);
            if (!id) return new Response(null, { status: 400 });
            sessions.delete(refresh);
            return issue(id);
          }
          const code = form.get("code")!;
          const query = requests.get(code)!;
          requests.delete(code);
          expect(form.get("redirect_uri")).toBe(query.get("redirect_uri"));
          const verifier = form.get("code_verifier")!;
          const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
          expect(challenge).toBe(query.get("code_challenge")!);
          return issue(code);
        }
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
        ...(signedIn ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    }),
    options,
  );
  if (!response) throw new Error("Device route is missing");
  return response;
}

function decide(id: string | null, user_code: string, approve: boolean) {
  if (!id) throw new Error("Missing device request id");
  const consent = { id, user_code, approve, issued_at: Date.now() };
  const proof = createHmac("sha256", consentKey)
    .update(deviceConsentMessage(consent, user.id, authorization))
    .digest("hex");
  return post(authDeviceDecide.route.path, { ...consent, proof }, true);
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
  const approve = { id, user_code, approve: true, issued_at: Date.now(), proof: "0".repeat(64) };
  expect((await post(authDeviceDecide.route.path, approve)).status).toBe(401);
  expect((await decide(id, user_code === "FFFFFFFF" ? "EEEEEEEE" : "FFFFFFFF", true)).status).toBe(404);
  expect(await poll(device_code)).toEqual({ status: "slow_down", interval: 10 });
  await db.query("update armada_auth.oauth_device_requests set next_poll_at = '-infinity' where id = $1", [id]);
  expect(await poll(device_code)).toEqual({ status: "authorization_pending", interval: 10 });
  expect((await post(authDeviceDecide.route.path, approve, true)).status).toBe(401);
  const decision = await decide(id, user_code, true);
  expect(authDeviceDecide.output.parse(await decision.json())).toEqual({ ok: true });
  expect((await decide(id, user_code, false)).status).toBe(404);
  await db.query("update armada_auth.oauth_device_requests set next_poll_at = '-infinity' where id = $1", [id]);
  const results = await Promise.all([poll(device_code), poll(device_code)]);
  expect(results.map(({ status }) => status).sort()).toEqual(["authorized", "expired_token"]);
  expect(results.find(({ status }) => status === "authorized")).toMatchObject({
    email: user.email,
  });
});

test("denial ends the device login", async () => {
  const { id, user_code, device_code } = await start();
  expect((await decide(id, user_code, false)).status).toBe(200);
  expect(await poll(device_code)).toEqual({ status: "access_denied" });
});

test("expired requests cannot be inspected, approved or redeemed", async () => {
  const { id, user_code, device_code } = await start();
  await db.query("update armada_auth.oauth_device_requests set expires_at = '-infinity' where id = $1", [id]);
  expect((await post(authDeviceInspect.route.path, { id }, true)).status).toBe(404);
  expect((await decide(id, user_code, true)).status).toBe(404);
  expect(await poll(device_code)).toEqual({ status: "expired_token" });
});

async function approveAndPoll(login: Awaited<ReturnType<typeof start>>) {
  expect((await decide(login.id, login.user_code, true)).status).toBe(200);
  await db.query("update armada_auth.oauth_device_requests set next_poll_at = '-infinity' where id = $1", [login.id]);
  const result = await poll(login.device_code);
  if (result.status !== "authorized") throw new Error("Expected a CLI session");
  return result;
}

test("CLI sign-in preserves an outstanding same-account passwordless email code", async () => {
  const { authEmailStart, authEmailVerify } = publicAuthOperations;
  expect(
    (
      await post(authEmailStart.route.path, {
        email: user.email,
        code_challenge: "x".repeat(43),
        redirect_uri: "http://127.0.0.1:43210/callback",
        state: "test-state",
      })
    ).status,
  ).toBe(200);
  await approveAndPoll(await start());
  const response = await post(authEmailVerify.route.path, { email: user.email, code: "123456" });
  expect(response.status).toBe(200);
  expect(authEmailVerify.output.parse(await response.json()).accessToken).toBe("email-access");
});

test("concurrent CLI logins for one account issue and rotate separate refresh sessions", async () => {
  const a = await start();
  const b = await start();
  const sessions = await Promise.all([approveAndPoll(a), approveAndPoll(b)]);
  expect(sessions[0]!.accessToken).not.toBe(sessions[1]!.accessToken);
  expect(sessions[0]!.refreshToken).not.toBe(sessions[1]!.refreshToken);
  const { authRefresh } = publicAuthOperations;
  const renewed = await Promise.all(
    sessions.map(async ({ refreshToken }) => {
      const response = await post(authRefresh.route.path, { refreshToken });
      expect(response.status).toBe(200);
      const next = authRefresh.output.parse(await response.json());
      expect(next.refreshToken).not.toBe(refreshToken);
      return next;
    }),
  );
  expect(renewed.map(({ accessToken }) => accessToken)).toEqual(sessions.map(({ accessToken }) => accessToken));
  expect(renewed[0]!.refreshToken).not.toBe(renewed[1]!.refreshToken);
});
