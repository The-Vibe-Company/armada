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
import { type DashboardTursoCache, fleetKeysOf, organizationKeys, type Release } from "../lib/broker.ts";
import { type CliAccounts, type CliApiDeps, type CliIdentity, handleCli } from "../lib/cli-api.ts";
import { deleteSecret, listEvents, type SecretName, setSecret, type VaultKey, vaultModeOf } from "../lib/vault.ts";

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
function cli(
  method: string,
  path: string,
  init: { body?: unknown; token?: string; key?: string } = {},
  deps: Omit<CliApiDeps, "accounts"> = {},
) {
  const headers = new Headers();
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.key) headers.set("x-api-key", init.key);
  const request = new Request(`${BASE}/api/cli/${path}`, {
    method,
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return handleCli(request, path.split("/"), { accounts: async () => accounts, ...deps });
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

describe("the organization's keys, handed to a signed-in terminal", () => {
  // Synthetic keys, for these tests only.
  const ORG_LINEAR = "lin_api_synthetic_org_0001";
  const OWN_LINEAR = "lin_api_synthetic_own_0002";
  const PLATFORM = "synthetic-platform-token-0003";
  const PLATFORM_NEW = "synthetic-platform-token-0004";
  const STORED = "synthetic-database-token-0005";
  const vaultMode = vaultModeOf({ ARMADA_SECRETS_KEY: Buffer.alloc(32, 3).toString("base64") });
  const vault = (vaultMode.kind === "on" ? vaultMode.key : null) as VaultKey;
  const start = new Date("2026-09-30T12:00:00Z");
  let now = start;
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

  /** The Turso Platform API, faked: every token it makes is numbered. */
  const turso: { url: string; token: string }[] = [];
  let tursoDown = false;
  const tursoFetch = async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    turso.push({ url, token: auth.replace(/^Bearer /, "") });
    if (tursoDown) return Response.json({ error: "token is invalid" }, { status: 401 });
    if (url.includes("/auth/tokens")) return Response.json({ jwt: `synthetic-minted-${turso.length}` });
    return Response.json({ database: { Name: "fleet", Hostname: "fleet-acme.turso.io" } });
  };
  const deps = { vault: () => vaultMode, fetch: tursoFetch, now: () => now };
  const keys = async (init: { token?: string; key?: string; held?: unknown }) => {
    const res = await cli(
      "POST",
      "credentials",
      { token: init.token, key: init.key, body: { turso: init.held ?? null } },
      deps,
    );
    return { res, body: (await res.json()) as Release & { error?: string; next?: string } };
  };
  const set = (name: SecretName, value: string, user: string | null = null) =>
    setSecret(client, vault, {
      organization: orgId,
      user,
      name,
      value,
      actor: { kind: "person", id: "owner", label: "Olive Owner" },
      now,
    });

  let ownerToken = "";
  let memberToken = "";
  let memberId = "";
  let apiKey = "";
  const logged: string[] = [];
  const original = { info: console.info, error: console.error };

  beforeAll(async () => {
    console.info = (...a: unknown[]) => void logged.push(a.join(" "));
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    const o = await auth.api.signInEmail({ body: { email: OWNER, password: PASSWORD } });
    const m = await auth.api.signInEmail({ body: { email: "member@example.test", password: PASSWORD } });
    ownerToken = o.token ?? "";
    memberToken = m.token ?? "";
    memberId = m.user.id;
    apiKey = (
      await auth.api.createApiKey({ body: { name: "vault coordinator", organizationId: orgId }, headers: as(owner) })
    ).key;
  });
  afterAll(() => {
    console.info = original.info;
    console.error = original.error;
  });

  test("without a vault, or without a sign-in, nothing is handed out and the next step is named", async () => {
    const off = await cli("POST", "credentials", { token: memberToken }, { vault: () => ({ kind: "off" }) });
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ next: expect.stringContaining("armada auth login") });
    const invalid = await cli(
      "POST",
      "credentials",
      { token: memberToken },
      { vault: () => vaultModeOf({ ARMADA_SECRETS_KEY: "short" }) },
    );
    expect(invalid.status).toBe(503);
    const anonymous = await keys({});
    expect(anonymous.res.status).toBe(401);
    expect(anonymous.body.next).toBe("armada login");
    // Nothing set yet: an answer with no key, recorded all the same.
    const empty = await keys({ token: memberToken });
    expect(empty.res.status).toBe(200);
    expect(empty.body).toMatchObject({ linear: null, turso: null, organization: { id: orgId, slug: "acme" } });
  });

  test("the Linear key is the person's own when set, else the organization's; an API key gets the organization's", async () => {
    await set("linear-api-key", ORG_LINEAR);
    expect((await keys({ token: memberToken })).body.linear).toEqual({ apiKey: ORG_LINEAR, scope: "organization" });
    await set("linear-api-key", OWN_LINEAR, memberId);
    expect((await keys({ token: memberToken })).body.linear).toEqual({ apiKey: OWN_LINEAR, scope: "own" });
    expect((await keys({ token: ownerToken })).body.linear).toEqual({ apiKey: ORG_LINEAR, scope: "organization" });
    expect((await keys({ key: apiKey })).body.linear).toEqual({ apiKey: ORG_LINEAR, scope: "organization" });
    await deleteSecret(client, {
      organization: orgId,
      user: memberId,
      name: "linear-api-key",
      actor: { kind: "person", id: memberId, label: "Mia" },
      now,
    });
    expect((await keys({ token: memberToken })).body.linear?.scope).toBe("organization");
  });

  test("a Turso token is made for the terminal, expires in hours, is kept while fresh and renewed near its end or when the keys change", async () => {
    await set("turso-platform-token", PLATFORM);
    await set("turso-organization", "acme");
    await set("turso-database", "fleet");
    turso.length = 0;

    const first = await keys({ token: memberToken });
    expect(first.res.headers.get("cache-control")).toBe("no-store");
    const t = first.body.turso;
    expect(t).toMatchObject({ kind: "minted", url: "libsql://fleet-acme.turso.io", token: "synthetic-minted-1" });
    if (t?.kind !== "minted") throw new Error("not minted");
    expect(t.expiresAt).toBe(at(4 * 60).toISOString());
    // The token is made with an expiry, through the Platform token, for this database only.
    const mint = turso.find((c) => c.url.includes("/auth/tokens"));
    expect(mint?.url).toBe(
      "https://api.turso.tech/v1/organizations/acme/databases/fleet/auth/tokens?expiration=4h&authorization=full-access",
    );
    expect(mint?.token).toBe(PLATFORM);

    const held = { revision: t.revision, expiresAt: t.expiresAt };
    now = at(60);
    turso.length = 0;
    expect((await keys({ token: memberToken, held })).body.turso).toEqual({
      kind: "kept",
      expiresAt: t.expiresAt,
      revision: t.revision,
    });
    expect(turso).toEqual([]);
    // Less than an hour left: a new one.
    now = at(3 * 60 + 30);
    const renewed = (await keys({ token: memberToken, held })).body.turso;
    expect(renewed?.kind).toBe("minted");
    // A claimed expiry beyond what Armada hands out is not one of its tokens.
    now = at(4 * 60);
    expect(
      (await keys({ token: memberToken, held: { revision: t.revision, expiresAt: at(60 * 24).toISOString() } })).body
        .turso?.kind,
    ).toBe("minted");

    // Replacing a Turso key takes effect on the next call, even for a fresh token.
    if (renewed?.kind !== "minted") throw new Error("not minted");
    now = at(4 * 60 + 1);
    await set("turso-platform-token", PLATFORM_NEW);
    turso.length = 0;
    const replaced = (
      await keys({ token: memberToken, held: { revision: renewed.revision, expiresAt: renewed.expiresAt } })
    ).body.turso;
    expect(replaced?.kind).toBe("minted");
    expect(replaced?.revision).not.toBe(renewed.revision);
    expect(turso.every((c) => c.token === PLATFORM_NEW)).toBe(true);
  });

  test("Turso refusing the Platform token hands out no Turso access and says why, without the token", async () => {
    tursoDown = true;
    const { body } = await keys({ token: memberToken });
    tursoDown = false;
    expect(body.turso).toBeNull();
    expect(body.linear?.apiKey).toBe(ORG_LINEAR);
    expect(body.warnings.join(" ")).toContain("HTTP 401");
    expect(body.warnings.join(" ")).not.toContain(PLATFORM_NEW);
  });

  test("without a Platform token, the stored database token is handed out and the audit list says so", async () => {
    for (const name of ["turso-platform-token", "turso-organization", "turso-database"] as const)
      await deleteSecret(client, {
        organization: orgId,
        user: null,
        name,
        actor: { kind: "person", id: "owner", label: "Olive Owner" },
        now,
      });
    await set("turso-url", "libsql://fleet-acme.turso.io");
    await set("turso-database-token", STORED);
    const { body } = await keys({ key: apiKey });
    expect(body.turso).toMatchObject({
      kind: "stored",
      url: "libsql://fleet-acme.turso.io",
      token: STORED,
      expiresAt: null,
    });
    const [latest] = await listEvents(client, orgId, 1);
    expect(latest).toMatchObject({
      action: "release",
      keys: ["linear-api-key", "turso-database-token"],
      actor: { kind: "api-key", label: 'API key "vault coordinator"' },
    });
    expect(latest?.detail).toContain("no Turso Platform API token");
  });

  test("every call is in the audit list, who and which key, and no value is ever logged or recorded", async () => {
    const events = await listEvents(client, orgId, 200);
    const releases = events.filter((e) => e.action === "release");
    expect(releases.some((e) => e.actor.label === "Mia Member <member@example.test>" && e.keys.includes("turso"))).toBe(
      true,
    );
    expect(releases.some((e) => e.detail.includes("Turso token kept"))).toBe(true);
    const everything = [
      JSON.stringify((await client.execute(`SELECT * FROM "armada_secret_event"`)).rows),
      ...logged,
    ].join("\n");
    for (const value of [ORG_LINEAR, OWN_LINEAR, PLATFORM, PLATFORM_NEW, STORED, "synthetic-minted-"])
      expect(everything).not.toContain(value);
    expect(logged.some((l) => l.includes("keys released to"))).toBe(true);
  });

  test("the dashboard reads with the organization's keys: its Turso token is kept in memory and renewed near its end", async () => {
    now = at(8 * 60);
    await set("turso-platform-token", PLATFORM);
    await set("turso-organization", "acme");
    await set("turso-database", "fleet");
    await set("github-token", "synthetic-github-token-0006");
    await set("linear-api-key", OWN_LINEAR, memberId);
    const cache: DashboardTursoCache = new Map();
    const read = () => organizationKeys({ client, vault, fetch: tursoFetch, now: () => now, cache }, orgId);
    turso.length = 0;
    const first = await read();
    // The organization's keys, never a person's own.
    expect(first).toMatchObject({ linearApiKey: ORG_LINEAR, githubToken: "synthetic-github-token-0006" });
    expect(first.turso?.expiresAt?.toISOString()).toBe(at(12 * 60).toISOString());
    const mints = () => turso.filter((c) => c.url.includes("/auth/tokens")).length;
    now = at(10 * 60);
    expect((await read()).turso?.token).toBe(first.turso?.token ?? "");
    expect(mints()).toBe(1);
    now = at(11 * 60 + 1);
    expect((await read()).turso?.token).not.toBe(first.turso?.token ?? "");
    expect(mints()).toBe(2);
    const [latest] = await listEvents(client, orgId, 1);
    expect(latest).toMatchObject({ action: "release", keys: ["turso"], actor: { kind: "dashboard" } });
  });

  test("an organization with its own Turso reads with none of the deployment's keys, unless it is the first one", () => {
    const env = {
      linearApiKey: "env-linear",
      githubToken: "env-github",
      turso: { url: "libsql://env.example.test", token: "env-turso" },
    };
    const none = { linearApiKey: null, githubToken: null, turso: null, warnings: [] };
    const ownTurso = { ...none, turso: { url: "libsql://own.example.test", token: "own", expiresAt: null } };
    const home = { organization: "org-a", home: "org-a" };
    const second = { organization: "org-b", home: "org-a" };
    // No Turso of its own: the deployment's registry, scoped as before, read with the deployment's keys.
    expect(fleetKeysOf(none, env, "org-b", second)).toEqual({ keys: { ...env, envRepositories: true }, scope: second });
    // Its own registry could list anyone's repository: nothing of the deployment's.
    expect(fleetKeysOf(ownTurso, env, "org-b", second)).toEqual({
      keys: { linearApiKey: null, githubToken: null, turso: ownTurso.turso, envRepositories: false },
      scope: { organization: "org-b", home: "org-b" },
    });
    // The first organization owns the deployment's keys.
    expect(fleetKeysOf(ownTurso, env, "org-a", home).keys).toMatchObject({
      linearApiKey: "env-linear",
      githubToken: "env-github",
      envRepositories: true,
    });
  });

  test("a terminal asking more than 30 times a minute is refused until the minute has passed", async () => {
    now = at(20 * 60);
    const codes: number[] = [];
    for (let k = 0; k < 31; k++) codes.push((await keys({ token: ownerToken })).res.status);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
    // Another caller is not held back.
    expect((await keys({ token: memberToken })).res.status).toBe(200);
    now = at(20 * 60 + 2);
    expect((await keys({ token: ownerToken })).res.status).toBe(200);
  });
});
