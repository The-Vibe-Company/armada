import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { NextRequest } from "next/server";
import { type Auth, createAuth, type EmailMessage } from "../lib/accounts.ts";
import { accountsGuard } from "../lib/accounts-http.ts";
import { type AuthSettings, accountsModeOf } from "../lib/accounts-settings.ts";
import { openAuthDatabase } from "../lib/auth-db.ts";
import { guard } from "../lib/auth-http.ts";
import { type CliAccounts, type CliIdentity, handleCli } from "../lib/cli-api.ts";

// Synthetic people and secrets, for these tests only.
const BASE = "http://localhost:4839";
const OWNER = "owner@example.test";
const PASSWORD = "a synthetic password";
const ENV = {
  ARMADA_AUTH_DATABASE_URL: "file:accounts.db",
  ARMADA_AUTH_SECRET: "a synthetic secret for tests, long enough",
  ARMADA_AUTH_URL: BASE,
  ARMADA_AUTH_OWNER_EMAILS: OWNER,
  NODE_ENV: "test",
};

let dir = "";
let client: Client;
let auth: Auth;
let settings: AuthSettings;
let accounts: CliAccounts;
const outbox: EmailMessage[] = [];
let owner = "";
let member = "";
let orgId = "";

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
}
const as = (cookie: string) => new Headers({ cookie });

async function signUp(email: string, name: string): Promise<string> {
  await auth.api.signUpEmail({ body: { email, name, password: PASSWORD } });
  const link = outbox.findLast((m) => m.kind === "verification" && m.to === email);
  return cookiesOf(await auth.handler(new Request(link?.url ?? "")));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "armada-cli-api-"));
  client = await openAuthDatabase({ url: `file:${join(dir, "accounts.db")}`, token: null });
  const mode = accountsModeOf(ENV);
  if (mode.kind !== "accounts") throw new Error("test settings incomplete");
  settings = mode.settings;
  auth = createAuth(settings, { client, sender: { send: async (m) => void outbox.push(m) } });
  accounts = { auth, client, settings };
  owner = await signUp(OWNER, "Olive Owner");
  const org = await auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: as(owner) });
  orgId = org?.id ?? "";
  const invitation = await auth.api.createInvitation({
    body: { email: "member@example.test", role: "member", organizationId: orgId },
    headers: as(owner),
  });
  member = await signUp("member@example.test", "Mia Member");
  await auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: as(member) });
});

afterAll(async () => {
  client.close();
  await rm(dir, { recursive: true, force: true });
});

/** One call from the terminal to /api/cli. */
function cli(method: string, path: string, init: { body?: unknown; token?: string; key?: string } = {}) {
  const headers = new Headers();
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.key) headers.set("x-api-key", init.key);
  const request = new Request(`${BASE}/api/cli/${path}`, {
    method,
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return handleCli(request, path.split("/"), { accounts: async () => accounts });
}

/** Polls once, as if the interval had passed since the last poll. */
async function poll(deviceCode: string) {
  await client.execute(`UPDATE "deviceCode" SET "lastPolledAt" = NULL`);
  const res = await cli("POST", "device/token", { body: { device_code: deviceCode } });
  return { res, body: (await res.json()) as Record<string, string> };
}

describe("armada login: the device code, confirmed in the browser", () => {
  test("the person approves the code on /device and the terminal gets a session; whoami names them; logout revokes it", async () => {
    const start = await cli("POST", "device/code");
    expect(start.status).toBe(200);
    const code = (await start.json()) as Record<string, string | number>;
    expect(code.verification_uri).toBe(`${BASE}/device`);
    expect(code.verification_uri_complete).toBe(`${BASE}/device?user_code=${code.user_code}`);
    expect(code.interval).toBe(5);
    const deviceCode = String(code.device_code);

    expect((await poll(deviceCode)).body.error).toBe("authorization_pending");
    // Polling again at once is too fast.
    const fast = await cli("POST", "device/token", { body: { device_code: deviceCode } });
    expect(((await fast.json()) as { error: string }).error).toBe("slow_down");

    // The browser: opening the page binds the code to the signed-in person, who approves it.
    const shown = await auth.api.deviceVerify({ query: { user_code: String(code.user_code) }, headers: as(owner) });
    expect(shown.status).toBe("pending");
    expect(await auth.api.deviceApprove({ body: { userCode: String(code.user_code) }, headers: as(owner) })).toEqual({
      success: true,
    });

    const { res, body } = await poll(deviceCode);
    expect(res.status).toBe(200);
    expect(body.token_type).toBe("Bearer");
    // The terminal keeps the token from the body; no cookie comes back.
    expect(res.headers.getSetCookie()).toEqual([]);
    const token = body.access_token ?? "";
    // A code is used once.
    expect((await poll(deviceCode)).body.error).toBe("invalid_grant");

    const who = await cli("GET", "session", { token });
    expect(who.status).toBe(200);
    expect((await who.json()) as CliIdentity).toMatchObject({
      schemaVersion: 1,
      via: "session",
      user: { email: OWNER, name: "Olive Owner" },
      organization: { id: orgId, name: "Acme", slug: "acme", role: "owner" },
      apiKey: null,
    });

    expect((await cli("DELETE", "session", { token })).status).toBe(200);
    const gone = await cli("GET", "session", { token });
    expect(gone.status).toBe(401);
    expect(await gone.json()).toMatchObject({ next: "armada login" });
  });

  test("a denied code signs nothing in; no credential, or a made-up one, is told to run armada login", async () => {
    const code = (await (await cli("POST", "device/code")).json()) as Record<string, string>;
    const userCode = code.user_code ?? "";
    await auth.api.deviceVerify({ query: { user_code: userCode }, headers: as(member) });
    // Only the person the code was bound to can approve it.
    await expect(auth.api.deviceApprove({ body: { userCode }, headers: as(owner) })).rejects.toThrow();
    await auth.api.deviceDeny({ body: { userCode }, headers: as(member) });
    expect((await poll(code.device_code ?? "")).body.error).toBe("access_denied");

    for (const res of [await cli("GET", "session"), await cli("GET", "session", { token: "made-up-token" })]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ next: "armada login" });
    }
  });
});

describe("a headless coordinator with an organization API key", () => {
  test("an owner creates a key for the organization; it signs a terminal in; revoked, it is refused", async () => {
    const created = await auth.api.createApiKey({
      body: { name: "cloud coordinator", organizationId: orgId },
      headers: as(owner),
    });
    expect(created.key.startsWith("armada_")).toBe(true);
    expect(created.referenceId).toBe(orgId);
    // A member cannot hand out the organization's keys.
    await expect(
      auth.api.createApiKey({ body: { name: "mine", organizationId: orgId }, headers: as(member) }),
    ).rejects.toThrow();

    const who = await cli("GET", "session", { key: created.key });
    expect(who.status).toBe(200);
    expect((await who.json()) as CliIdentity).toMatchObject({
      via: "api-key",
      user: null,
      organization: { id: orgId, name: "Acme" },
      apiKey: { name: "cloud coordinator", start: created.key.slice(0, 11) },
    });
    // Checked on every command: no daily cap.
    for (let k = 0; k < 12; k++) expect((await cli("GET", "session", { key: created.key })).status).toBe(200);
    // A key is revoked in the app, not signed out from the terminal.
    expect((await cli("DELETE", "session", { key: created.key })).status).toBe(400);

    await auth.api.deleteApiKey({ body: { keyId: created.id }, headers: as(owner) });
    const revoked = await cli("GET", "session", { key: created.key });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ next: "armada login" });
  });
});

describe("without accounts", () => {
  test("every CLI route refuses with the next step; both gates let the CLI's routes through to say so", async () => {
    const request = new Request(`${BASE}/api/cli/device/code`, { method: "POST" });
    const res = await handleCli(request, ["device", "code"], { accounts: async () => null });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; next: string };
    expect(body.error).toContain("no accounts");
    expect(body.next).toContain("ARMADA_AUTH_");

    const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";
    const password = { NODE_ENV: "production", ARMADA_DASHBOARD_PASSWORD: "synthetic password" };
    expect(passed(guard(new NextRequest(`${BASE}/api/cli/session`), { env: password, now: 0 }))).toBe(true);
    let looked = false;
    const signedOut = async () => {
      looked = true;
      return "none" as const;
    };
    expect(
      passed(await accountsGuard(new NextRequest(`${BASE}/api/cli/session`), { env: {}, session: signedOut })),
    ).toBe(true);
    expect(looked).toBe(false);
  });
});
