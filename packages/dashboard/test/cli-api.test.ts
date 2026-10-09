import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { armadaApi, MINIMUM_CLI_VERSION, parseConfig } from "@armada/core/read";
import { NextRequest } from "next/server";
import { DEMO_TOML, issue, NOW } from "../../core/test/support.ts";
import { type Auth, createAuth, type EmailMessage } from "../lib/accounts.ts";
import { accountsGuard } from "../lib/accounts-http.ts";
import { type AuthSettings, accountsModeOf } from "../lib/accounts-settings.ts";
import { guard } from "../lib/auth-http.ts";
import { fleetKeysOf, organizationKeys, type Release } from "../lib/broker.ts";
import { type CliAccounts, type CliApiDeps, type CliIdentity, handleCli } from "../lib/cli-api.ts";
import type { Database } from "../lib/db.ts";
import { dbSnapshots, memorySnapshots } from "../lib/snapshots.ts";
import { deleteSecret, listEvents, type SecretName, setSecret, type VaultKey, vaultModeOf } from "../lib/vault.ts";
import { tempDatabase } from "./support.ts";

// Synthetic people and secrets, for these tests only.
const BASE = "http://localhost:4839";
const OWNER = "owner@example.test";
const PASSWORD = "a synthetic password";
const ENV = {
  ARMADA_DATABASE_URL: "pglite:memory",
  ARMADA_AUTH_SECRET: "a synthetic secret for tests, long enough",
  ARMADA_AUTH_URL: BASE,
  ARMADA_AUTH_OWNER_EMAILS: OWNER,
  NODE_ENV: "test",
};

let client: Database;
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
  client = await tempDatabase();
}, 10_000);

beforeAll(async () => {
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
  await client.end();
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
  await client.query(`UPDATE "deviceCode" SET "lastPolledAt" = NULL`);
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
    // Every answer, a refusal too, names the CLIs it is for.
    expect(res.headers.get("x-armada-cli-minimum")).toBe(MINIMUM_CLI_VERSION);
    expect(res.headers.get("x-armada-cli-latest")).toBe(MINIMUM_CLI_VERSION);

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

describe("an outdated CLI", () => {
  test("a CLI older than the minimum is refused before anything runs, with the upgrade line", async () => {
    const request = (version: string) =>
      new Request(`${BASE}/api/cli/device/code`, { method: "POST", headers: { "x-armada-cli-version": version } });
    const before = (await client.query(`SELECT count(*)::int AS n FROM "deviceCode"`)).rows[0] as { n: number };
    const old = await handleCli(request("0.1.22"), ["device", "code"], { accounts: async () => accounts });
    expect(old.status).toBe(426);
    expect(await old.json()).toEqual({
      error: `Armada 0.1.22 is older than this server expects: npm install -g @the-vibe-company/armada@${MINIMUM_CLI_VERSION}`,
      next: `npm install -g @the-vibe-company/armada@${MINIMUM_CLI_VERSION}`,
    });
    const after = (await client.query(`SELECT count(*)::int AS n FROM "deviceCode"`)).rows[0] as { n: number };
    expect(after.n).toBe(before.n);
    const current = await handleCli(request(MINIMUM_CLI_VERSION), ["device", "code"], {
      accounts: async () => accounts,
    });
    expect(current.status).toBe(200);
  });
});

describe("the organization's keys, handed to a signed-in terminal", () => {
  // Synthetic keys, for these tests only.
  const ORG_LINEAR = "lin_api_synthetic_org_0001";
  const OWN_LINEAR = "lin_api_synthetic_own_0002";
  const vaultMode = vaultModeOf({ ARMADA_SECRETS_KEY: Buffer.alloc(32, 3).toString("base64") });
  const vault = (vaultMode.kind === "on" ? vaultMode.key : null) as VaultKey;
  const start = new Date("2026-09-30T12:00:00Z");
  let now = start;
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

  const deps = { vault: () => vaultMode, now: () => now };
  const keys = async (init: { token?: string; key?: string }) => {
    const res = await cli("POST", "credentials", { token: init.token, key: init.key, body: {} }, deps);
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
    // A CLI from before 0.2.0 still asks for the retired database's token, without a version: it is told to upgrade.
    const old = await cli("POST", "credentials", { token: memberToken, body: { turso: null } }, deps);
    expect(old.status).toBe(426);
    expect(await old.json()).toEqual({
      error: `this CLI is older than this server expects (${MINIMUM_CLI_VERSION} or newer)`,
      next: `npm install -g @the-vibe-company/armada@${MINIMUM_CLI_VERSION}`,
    });
    const anonymous = await keys({});
    expect(anonymous.res.status).toBe(401);
    expect(anonymous.body.next).toBe("armada login");
    // Nothing set yet: an answer with no key, recorded all the same.
    const empty = await keys({ token: memberToken });
    expect(empty.res.status).toBe(200);
    expect(empty.body).toEqual({
      schemaVersion: 1,
      organization: { id: orgId, name: "Acme", slug: "acme" },
      linear: null,
      warnings: [],
    });
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

  test("every call is in the audit list, who and which key, and no value is ever logged or recorded", async () => {
    const events = await listEvents(client, orgId, 200);
    const releases = events.filter((e) => e.action === "release");
    expect(
      releases.some((e) => e.actor.label === "Mia Member <member@example.test>" && e.keys.includes("linear-api-key")),
    ).toBe(true);
    expect(releases.some((e) => e.actor.label === 'API key "vault coordinator"')).toBe(true);
    const everything = [
      JSON.stringify((await client.query(`SELECT * FROM "armada_secret_event"`)).rows),
      ...logged,
    ].join("\n");
    for (const value of [ORG_LINEAR, OWN_LINEAR]) expect(everything).not.toContain(value);
    expect(logged.some((l) => l.includes("keys released to"))).toBe(true);
  });

  test("a lost credential response retries the reusable key read, auditing both attempts and respecting the limit", async () => {
    now = at(2);
    // Put this actor two releases away from the minute's limit.
    for (let k = 0; k < 28; k++) expect((await keys({ token: ownerToken })).res.status).toBe(200);
    const before = (await listEvents(client, orgId, 200)).filter((e) => e.action === "release").length;
    let calls = 0;
    const api = armadaApi({
      url: BASE,
      version: MINIMUM_CLI_VERSION,
      fetch: async (url, init) => {
        const response = await handleCli(new Request(url, init), ["credentials"], {
          accounts: async () => accounts,
          ...deps,
        });
        if (++calls === 1) {
          // The server completed the read/audit, but the response was lost.
          await response.body?.cancel();
          throw new DOMException("response lost", "TimeoutError");
        }
        return response;
      },
    });
    const signIn = { kind: "session" as const, token: ownerToken };
    expect((await api.credentials(signIn)).linear?.apiKey).toBe(ORG_LINEAR);
    expect(calls).toBe(2);
    expect((await listEvents(client, orgId, 200)).filter((e) => e.action === "release")).toHaveLength(before + 2);
    // Two actual releases use two slots; a 429 is never retried or bypassed.
    await expect(api.credentials(signIn)).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(3);
    now = at(4);
    expect((await api.credentials(signIn)).linear?.apiKey).toBe(ORG_LINEAR);
    expect(calls).toBe(4);
  });

  test("the dashboard reads with the organization's Linear and GitHub keys, never a person's own", async () => {
    now = at(8 * 60);
    await set("github-token", "synthetic-github-token-0006");
    await set("linear-api-key", OWN_LINEAR, memberId);
    const own = await organizationKeys({ client, vault }, orgId);
    expect(own).toEqual({ linearApiKey: ORG_LINEAR, githubToken: "synthetic-github-token-0006", warnings: [] });
  });

  test("only the first organization, and the shared-password gate, fall back to the deployment's keys", () => {
    const env = { linearApiKey: "env-linear", githubToken: "env-github" };
    const none = { linearApiKey: null, githubToken: null, warnings: [] };
    const home = { organization: "org-a", home: "org-a" };
    const second = { organization: "org-b", home: "org-a" };
    expect(fleetKeysOf(none, env, home)).toEqual({ ...env, envRepositories: true });
    expect(fleetKeysOf(null, env, null)).toEqual({ ...env, envRepositories: true });
    // Another organization could name anyone's repository in its registry: nothing of the deployment's.
    expect(fleetKeysOf(none, env, second)).toEqual({ linearApiKey: null, githubToken: null, envRepositories: false });
    expect(fleetKeysOf({ ...none, linearApiKey: "own" }, env, second)).toMatchObject({ linearApiKey: "own" });
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

test("deferred launches use stored facts and coordinator ownership across authenticated API keys", async () => {
  const a = await auth.api.createApiKey({ body: { name: "same name", organizationId: orgId }, headers: as(owner) });
  const b = await auth.api.createApiKey({ body: { name: "same name", organizationId: orgId }, headers: as(owner) });
  const config = parseConfig(DEMO_TOML.replace('slug = "widgets"', 'slug = "deferred-api"'));
  const project = {
    slug: config.project.slug,
    name: config.project.name,
    repository: config.github.repository,
    programRoot: config.tracker.programRoot,
  };
  const input = { kind: "launch-when-unblocked", ticket: "DEMO-9", author: "forged" };
  const send = (path: string, key: string, input: unknown) =>
    cli("POST", `fleet/${path}`, { key, body: { project, input } });
  expect((await send("request", a.key, input)).status).toBe(400);
  const program = {
    rootId: "DEMO-1",
    issues: [
      issue("DEMO-1", { parentId: null }),
      issue("DEMO-7", { parentId: "DEMO-1" }),
      issue("DEMO-9", { parentId: "DEMO-1", blockedBy: [{ id: "DEMO-7", statusType: "unstarted" }] }),
    ],
    comments: [],
    warnings: [],
    fetchedAt: NOW.toISOString(),
  };
  const snapshots = dbSnapshots(client, memorySnapshots());
  const claim = await snapshots.claim(project.slug, NOW, 60_000);
  if (!claim) throw new Error("missing refresh lease");
  await snapshots.save(
    project.slug,
    { config, configWarning: null, startedAt: NOW, sources: { program, forge: null, forgeError: null } },
    claim,
    { full: true, now: NOW },
  );
  const created = await send("request", a.key, input);
  expect(created.status).toBe(200);
  expect(await created.json()).toMatchObject({
    result: { blockers: ["DEMO-7"], author: `same name [api-key:${a.id}]`, owned: true },
  });
  expect(await (await send("launch-requests", a.key, { supportsDeferredAttempts: true })).json()).toMatchObject({
    result: [{ owned: true }],
  });
  expect(await (await send("launch-requests", b.key, { supportsDeferredAttempts: true })).json()).toMatchObject({
    result: [{ owned: true }],
  });
  expect(await (await send("launch-requests", b.key, { coordinatorName: "other" })).json()).toMatchObject({
    result: [],
  });
});
