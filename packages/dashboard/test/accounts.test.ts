import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { getMigrations } from "better-auth/db/migration";
import { NextRequest } from "next/server";
import { type Auth, createAuth, type EmailMessage, firstOrganization } from "../lib/accounts.ts";
import { accountsGuard, type SessionState } from "../lib/accounts-http.ts";
import { type AuthSettings, accountsModeOf, signatureOf } from "../lib/accounts-settings.ts";
import { AUTH_SCHEMA_VERSION, migrateAuth, openAuthDatabase } from "../lib/auth-db.ts";

// Synthetic people and secrets, for these tests only.
const BASE = "http://localhost:4838";
const OWNER = "owner@example.test";
const SECRET = "a synthetic secret for tests, long enough";
const PASSWORD = "a synthetic password";

const ENV = {
  ARMADA_AUTH_DATABASE_URL: "file:accounts.db",
  ARMADA_AUTH_SECRET: SECRET,
  ARMADA_AUTH_URL: BASE,
  ARMADA_AUTH_GITHUB_CLIENT_ID: "synthetic-client-id",
  ARMADA_AUTH_GITHUB_CLIENT_SECRET: "synthetic-client-secret",
  ARMADA_AUTH_OWNER_EMAILS: `Owner@Example.test, second-owner@example.test`,
};

describe("which deployment runs on accounts", () => {
  test("every required variable turns accounts on; anything missing leaves the password gate, named", () => {
    const on = accountsModeOf({ ...ENV, NODE_ENV: "production" });
    expect(on.kind).toBe("accounts");
    if (on.kind === "accounts") {
      expect(on.settings.owners).toEqual([OWNER, "second-owner@example.test"]);
      // Email and password stay off in production unless asked for.
      expect(on.settings.emailPassword).toBe(false);
    }
    const off = (env: Record<string, string>) => {
      const mode = accountsModeOf({ NODE_ENV: "production", ...env });
      return mode.kind === "off" ? mode.missing : [];
    };
    expect(off({})).toEqual([
      "ARMADA_AUTH_DATABASE_URL",
      "ARMADA_AUTH_SECRET",
      "ARMADA_AUTH_URL",
      "ARMADA_AUTH_GITHUB_CLIENT_ID",
    ]);
    // A remote database needs its token, a secret its length, GitHub both halves.
    expect(off({ ...ENV, ARMADA_AUTH_DATABASE_URL: "libsql://accounts.example.test" })).toEqual([
      "ARMADA_AUTH_DATABASE_TOKEN",
    ]);
    expect(off({ ...ENV, ARMADA_AUTH_SECRET: "short" })).toEqual(["ARMADA_AUTH_SECRET"]);
    expect(off({ ...ENV, ARMADA_AUTH_GITHUB_CLIENT_SECRET: "" })).toEqual(["ARMADA_AUTH_GITHUB_CLIENT_SECRET"]);
    // Without GitHub, email and password must be turned on for anyone to sign in.
    const noGithub = { ...ENV, ARMADA_AUTH_GITHUB_CLIENT_ID: "", ARMADA_AUTH_GITHUB_CLIENT_SECRET: "" };
    expect(off(noGithub)).toEqual(["ARMADA_AUTH_GITHUB_CLIENT_ID"]);
    expect(accountsModeOf({ NODE_ENV: "production", ...noGithub, ARMADA_AUTH_EMAIL_PASSWORD: "on" }).kind).toBe(
      "accounts",
    );
  });

  test("a request is signed with the person's name and address, within core's 80 characters", () => {
    expect(signatureOf({ name: "Ada Lovelace", email: "ada@example.test" })).toBe("Ada Lovelace <ada@example.test>");
    expect(signatureOf({ name: "ada@example.test", email: "ada@example.test" })).toBe("ada@example.test");
    expect(signatureOf({ name: "A".repeat(90), email: "ada@example.test" })).toBe("ada@example.test");
  });
});

// ------------------------------------------------------------ Better Auth on a local database

let dir = "";
let client: Client;
let auth: Auth;
let settings: AuthSettings;
const outbox: EmailMessage[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "armada-accounts-"));
  client = await openAuthDatabase({ url: `file:${join(dir, "accounts.db")}`, token: null });
  const mode = accountsModeOf({ ...ENV, NODE_ENV: "test" });
  if (mode.kind !== "accounts") throw new Error("test settings incomplete");
  settings = mode.settings;
  auth = createAuth(settings, {
    client,
    sender: {
      send: async (m) => {
        outbox.push(m);
      },
    },
  });
});

afterAll(async () => {
  client.close();
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  outbox.length = 0;
});

/** The cookies a response sets, as a request's Cookie header. */
function cookiesOf(res: Response, previous = ""): string {
  const jar = new Map(
    previous
      .split("; ")
      .filter(Boolean)
      .map((c) => c.split("=", 2) as [string, string]),
  );
  for (const line of res.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

const headersWith = (cookie: string) => new Headers({ cookie });

/** Signs up with email and password, then opens the verification link: the account is signed in. */
async function signUp(email: string, name: string): Promise<string> {
  await auth.api.signUpEmail({ body: { email, name, password: PASSWORD } });
  const link = outbox.findLast((m) => m.kind === "verification" && m.to === email);
  if (!link) throw new Error(`no verification email for ${email}`);
  const res = await auth.handler(new Request(link.url));
  const cookie = cookiesOf(res);
  expect(cookie).toContain("armada.session_token=");
  return cookie;
}

const code = async (work: Promise<unknown>) => {
  try {
    await work;
    return "ok";
  } catch (err) {
    return (err as { body?: { code?: string } }).body?.code ?? String(err);
  }
};

describe("the accounts database", () => {
  test("the committed migrations are what Better Auth needs, and replaying them changes nothing", async () => {
    const plan = await getMigrations(auth.options);
    expect(plan.toBeCreated).toEqual([]);
    expect(plan.toBeAdded).toEqual([]);
    expect(plan.toBeAddedIndexes).toEqual([]);
    expect(await migrateAuth(client)).toBe(AUTH_SCHEMA_VERSION);
  });
});

describe("accounts and organizations", () => {
  test("an account is by invitation; an owner address signs up, confirms it and creates the first organization", async () => {
    // Better Auth answers a refused sign-up like any other (no address enumeration), but creates nothing.
    await auth.api.signUpEmail({ body: { email: "stranger@example.test", name: "S", password: PASSWORD } });
    expect(outbox).toEqual([]);
    expect((await client.execute(`SELECT count(*) AS n FROM "user"`)).rows[0]?.n).toBe(0);

    await auth.api.signUpEmail({ body: { email: OWNER, name: "Olive Owner", password: PASSWORD } });
    // No session before the address is confirmed.
    expect(await code(auth.api.signInEmail({ body: { email: OWNER, password: PASSWORD } }))).toBe("EMAIL_NOT_VERIFIED");
    const link = outbox.findLast((m) => m.kind === "verification");
    expect(link?.to).toBe(OWNER);
    const owner = cookiesOf(await auth.handler(new Request(link?.url ?? "")));
    const session = await auth.api.getSession({ headers: headersWith(owner) });
    expect(session?.user.email).toBe(OWNER);
    // The session cookie is HttpOnly and SameSite=Lax.
    const signIn = await auth.api.signInEmail({ body: { email: OWNER, password: PASSWORD }, asResponse: true });
    const line = signIn.headers.getSetCookie().find((c) => c.startsWith("armada.session_token=")) ?? "";
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Lax");

    const org = await auth.api.createOrganization({
      body: { name: "Acme", slug: "acme-1" },
      headers: headersWith(owner),
    });
    expect(org?.members[0]?.role).toBe("owner");
    expect(await firstOrganization(client)).toEqual({ id: org?.id ?? "", name: "Acme" });
  });

  test("an owner invites by email; the invited address signs up, and after accepting belongs to the organization", async () => {
    const owner = cookiesOf(
      await auth.api.signInEmail({ body: { email: OWNER, password: PASSWORD }, asResponse: true }),
    );
    const org = await firstOrganization(client);
    const invitation = await auth.api.createInvitation({
      body: { email: "Member@Example.test", role: "member", organizationId: org?.id ?? "" },
      headers: headersWith(owner),
    });
    const sent = outbox.find((m) => m.kind === "invitation");
    expect(sent?.to).toBe("member@example.test");
    expect(sent?.url).toBe(`${BASE}/invitations/${invitation.id}`);

    // Only the invited address can accept it.
    expect(
      await code(auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: headersWith(owner) })),
    ).not.toBe("ok");
    // The invitation lets that address create an account; a member cannot create organizations.
    const member = await signUp("member@example.test", "Mia Member");
    expect(
      await code(auth.api.createOrganization({ body: { name: "Mine", slug: "mine" }, headers: headersWith(member) })),
    ).not.toBe("ok");
    const accepted = await auth.api.acceptInvitation({
      body: { invitationId: invitation.id },
      headers: headersWith(member),
    });
    expect(accepted?.member.role).toBe("member");

    // A new session starts in the person's organization.
    const again = cookiesOf(
      await auth.api.signInEmail({ body: { email: "member@example.test", password: PASSWORD }, asResponse: true }),
    );
    const session = await auth.api.getSession({ headers: headersWith(again) });
    expect(session?.session).toMatchObject({ activeOrganizationId: org?.id });
    // A member cannot invite.
    expect(
      await code(
        auth.api.createInvitation({
          body: { email: "friend@example.test", role: "member", organizationId: org?.id ?? "" },
          headers: headersWith(again),
        }),
      ),
    ).not.toBe("ok");
  });
});

// ------------------------------------------------------------ GitHub, faked

describe("GitHub sign-in", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Plays GitHub for one sign-in: the token exchange, the profile and its emails. */
  function fakeGitHub(email: string, verified = true) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://github.com/login/oauth/access_token"))
        return Response.json({ access_token: "synthetic-token", token_type: "bearer", scope: "read:user,user:email" });
      if (url === "https://api.github.com/user")
        return Response.json({ id: 4242, login: "octo", name: "Octo Cat", email, avatar_url: null });
      if (url === "https://api.github.com/user/emails")
        return Response.json([{ email, primary: true, verified, visibility: "public" }]);
      throw new Error(`no network in tests: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;
  }

  async function signInWithGitHub(email: string, verified = true): Promise<Response> {
    const start = await auth.api.signInSocial({
      body: { provider: "github", callbackURL: "/", errorCallbackURL: "/login" },
      asResponse: true,
    });
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get("state") ?? "";
    fakeGitHub(email, verified);
    return auth.handler(
      new Request(`${BASE}/api/auth/callback/github?code=synthetic-code&state=${state}`, {
        headers: { cookie: cookiesOf(start) },
      }),
    );
  }

  test("a stranger, or an owner address GitHub has not verified, is sent back with no session; an owner gets in", async () => {
    for (const [refused, why] of [
      [await signInWithGitHub("octo-stranger@example.test"), "NOT_INVITED"],
      [await signInWithGitHub("second-owner@example.test", false), "GITHUB_EMAIL_NOT_VERIFIED"],
    ] as const) {
      const back = new URL(refused.headers.get("location") ?? "", BASE);
      expect(back.pathname).toBe("/login");
      expect(back.searchParams.get("error")?.toUpperCase()).toContain(why);
      expect(cookiesOf(refused)).not.toContain("armada.session_token=");
    }

    const welcomed = await signInWithGitHub("second-owner@example.test");
    expect(new URL(welcomed.headers.get("location") ?? "", BASE).pathname).toBe("/");
    const session = await auth.api.getSession({ headers: headersWith(cookiesOf(welcomed)) });
    expect(session?.user).toMatchObject({ email: "second-owner@example.test", emailVerified: true });
  });
});

// ------------------------------------------------------------ the proxy

describe("the proxy with accounts", () => {
  const request = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    new NextRequest(`${BASE}${path}`, { method: init.method ?? "GET", headers: new Headers(init.headers) });
  const deps = (state: SessionState) => ({ env: {}, session: async () => state });
  const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";

  test("without a session, pages go to sign-in and data answers 401; Better Auth's routes and sign-in pass", async () => {
    const page = await accountsGuard(request("/organization"), deps("none"));
    expect(page.status).toBe(307);
    expect(new URL(page.headers.get("location") ?? "").search).toBe("?next=%2Forganization");
    for (const res of [
      await accountsGuard(request("/api/fleet"), deps("none")),
      await accountsGuard(request("/", { method: "POST", headers: { "next-action": "7f00aa" } }), deps("none")),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(passed(await accountsGuard(request("/login"), deps("none")))).toBe(true);
    expect(passed(await accountsGuard(request("/api/auth/callback/github?code=x"), deps("none")))).toBe(true);
  });

  test("with a session everything passes but the sign-in page; an unreadable accounts database fails closed", async () => {
    expect(passed(await accountsGuard(request("/api/fleet"), deps("signed-in")))).toBe(true);
    expect((await accountsGuard(request("/login"), deps("signed-in"))).status).toBe(303);
    for (const path of ["/", "/api/fleet", "/login"])
      expect((await accountsGuard(request(path), deps("unavailable"))).status).toBe(503);
  });
});
