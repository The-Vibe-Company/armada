import { expect, test } from "bun:test";
import { createMemoryAuthStore, memorySessionStore } from "@armada/auth";
import { antigravityLoginOperations, antigravityLoginPath } from "@armada/core/contract";
import { decryptSecret, type VaultStore } from "@armada/core/server";
import { type ControlOptions, handleControlRequest } from "@armada/mcp-server";
import { createAntigravityLogin } from "../../mcp-server/src/antigravity-login.ts";
import { observeRequest } from "../../mcp-server/src/request-observability.ts";
import { run } from "../src/run.ts";

const user = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const org = "33333333-3333-4333-8333-333333333333";
const account = "44444444-4444-4444-8444-444444444444";
const loginPath = antigravityLoginOperations.startAntigravityLogin.route.path;
const link =
  "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=matching";
const code = "pasted/code";
const credential = { method: "google", token: { access_token: "private-access", refresh_token: "private-refresh" } };
const token = (id: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: id })).replace(/=+$/, "")}.sig`;
const key = Buffer.alloc(32, 9).toString("base64");

function fixture() {
  const authStore = createMemoryAuthStore();
  const membership = { orgId: org, name: "Example", role: "admin" } as const;
  authStore.addMembership(user, membership);
  authStore.addMembership(other, membership);

  const submitted: string[] = [];
  const saved: { owner: string; scope: string; name: string | undefined; sealed: Uint8Array }[] = [];
  const logs: string[] = [];
  const { promise: exited, resolve: exit } = Promise.withResolvers<number>();
  const login = createAntigravityLogin(async () => ({
    authorizationUrl: Promise.resolve(link),
    exited,
    async submitCode(value) {
      submitted.push(value);
      exit(0);
    },
    async readToken() {
      return credential.token;
    },
    async close() {
      exit(1);
    },
  }));

  const store = {
    async memberships() {
      return [{ ...membership, id: org }];
    },
    async mutateAccount(owner, input, sealed) {
      if (!sealed) throw new Error("Missing ciphertext");
      saved.push({ owner, scope: input.scope, name: input.name, sealed });
      return { id: account, kind: "antigravity", name: input.name!, version: 1, createdAt: null };
    },
  } satisfies Partial<VaultStore>;
  const options: ControlOptions = {
    antigravityLogin: login,
    store: store as unknown as VaultStore,
    authStore,
    encryptionKey: key,
    supabase: {
      supabaseUrl: "https://supabase.test",
      anonKey: "anon",
      async fetch(_input, init) {
        const bearer = new Headers(init?.headers).get("authorization");
        if (bearer === `Bearer ${token(user)}`) return Response.json({ id: user });
        if (bearer === `Bearer ${token(other)}`) return Response.json({ id: other });
        return new Response(null, { status: 401 });
      },
    },
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : String(input), init);
    return observeRequest(
      async () => (await handleControlRequest(request, options)) ?? new Response(null, { status: 404 }),
      (line) => logs.push(line),
      request,
    );
  };
  const post = (path: string, body: unknown, id?: string) =>
    fetch(`https://armada.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(id ? { authorization: `Bearer ${token(id)}` } : {}) },
      body: JSON.stringify(body),
    });
  return { fetch, post, submitted, saved, logs, shutdown: login.shutdown };
}

test("the CLI exchanges a pasted Google code through the authenticated routes and prints account metadata", async () => {
  const server = fixture();
  const output: string[] = [];
  const opened: string[] = [];
  const write = (chunk: string) => output.push(chunk);
  const exit = await run(
    ["account", "login", "antigravity", "--name", "google"],
    { out: write, err: write },
    {
      readStdin: async () => code,
      auth: {
        out: write,
        err: write,
        open: (url) => opened.push(url),
        env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: token(user) },
        fetch: server.fetch,
        now: () => new Date(),
        interactive: true,
        session: memorySessionStore(),
      },
    },
  );
  expect({ exit, output }).toMatchObject({ exit: 0 });
  expect(opened).toEqual([link]);
  expect(server.submitted).toEqual([code]);
  expect(server.saved).toEqual([{ owner: user, scope: "user", name: "google", sealed: expect.any(Uint8Array) }]);
  expect(JSON.parse(await decryptSecret(server.saved[0]!.sealed, key))).toEqual(credential);
  const text = output.join("");
  expect(text).toContain(link);
  expect(text).toContain(account);
  for (const value of [code, ...Object.values(credential.token)])
    expect(text + server.logs.join("")).not.toContain(value);
});

test("the HTTP boundary refuses unauthenticated start and a different user's completion", async () => {
  const server = fixture();
  try {
    expect((await server.post(loginPath, { name: "google" })).status).toBe(401);
    const started = await server.post(loginPath, { name: "google" }, user);
    expect(started.status).toBe(200);
    const { loginId } = antigravityLoginOperations.startAntigravityLogin.output.parse(await started.json());
    const foreign = await server.post(antigravityLoginPath(loginId), { code }, other);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: { code: "not_found", message: "Start sign-in again." } });
    expect(server.submitted).toEqual([]);
    expect(server.saved).toEqual([]);
  } finally {
    await server.shutdown();
  }
});
