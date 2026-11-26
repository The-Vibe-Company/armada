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
const secondOrg = "55555555-5555-4555-8555-555555555555";
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
  authStore.addMembership(user, { ...membership, orgId: secondOrg, name: "Second" });
  authStore.addMembership(user, membership);
  authStore.addMembership(other, membership);

  const submitted: string[] = [];
  const saved: { owner: string; scope: string; name: string | undefined; sealed: Uint8Array }[] = [];
  const logs: string[] = [];
  const login = createAntigravityLogin(async () => {
    const { promise: exited, resolve: exit } = Promise.withResolvers<number>();
    return {
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
    };
  });

  const store = {
    async memberships() {
      return [
        { ...membership, id: org },
        { ...membership, id: secondOrg, name: "Second" },
      ];
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
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
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

async function signIn(server: ReturnType<typeof fixture>, paste: string, extraArgs: string[] = []) {
  const output: string[] = [];
  const opened: string[] = [];
  const write = (chunk: string) => output.push(chunk);
  const exit = await run(
    ["account", "login", "antigravity", "--name", "google", ...extraArgs],
    { out: write, err: write },
    {
      readStdin: async () => paste,
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
  return { exit, output, opened };
}

test("the CLI exchanges a pasted Google code through the authenticated routes and prints account metadata", async () => {
  const server = fixture();
  const { exit, output, opened } = await signIn(server, code);
  expect({ exit, output }).toMatchObject({ exit: 0 });
  expect(opened).toEqual([link]);
  expect(server.submitted).toEqual([code]);
  expect(server.saved).toEqual([{ owner: user, scope: "user", name: "google", sealed: expect.any(Uint8Array) }]);
  expect(JSON.parse(await decryptSecret(new Uint8Array(server.saved[0]!.sealed), key))).toEqual(credential);
  const text = output.join("");
  expect(text).toContain(link);
  expect(text).toContain(account);
  for (const value of [code, ...Object.values(credential.token)])
    expect(text + server.logs.join("")).not.toContain(value);
  expect((await signIn(server, code, ["--json"])).exit).toBe(0);
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

test("a refused code can be retried with a fresh CLI sign-in immediately", async () => {
  const server = fixture();
  const refused = await signIn(server, "bad\ncode");
  expect(refused.exit).not.toBe(0);
  expect(server.submitted).toEqual([]);
  expect((await signIn(server, code)).exit).toBe(0);
});

test("antigravity login wraps malformed start, unsafe link, and complete responses into typed exit-1 errors", async () => {
  for (const stage of ["start", "unsafe", "complete"] as const) {
    const { exit, output } = await signIn(
      {
        fetch: async (input) =>
          String(input).endsWith(loginPath)
            ? Response.json(
                stage === "start"
                  ? { bad: true }
                  : {
                      loginId: account,
                      authorizationUrl: stage === "unsafe" ? "https://evil.example/auth" : link,
                    },
              )
            : Response.json({ bad: true }),
      } as ReturnType<typeof fixture>,
      code,
    );
    expect(exit).toBe(1);
    expect(output.join("")).toMatch(/invalid Antigravity|unsafe Google link/);
  }
});
