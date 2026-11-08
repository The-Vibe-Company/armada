import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { type GitHubInstallationApp, goldenGitHubAdapter } from "../src/server.ts";

const actor = { userId: "u", orgId: "o", role: "admin" } as const;
const app: GitHubInstallationApp = { appId: "1", privateKey: "bad key" };
const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const signedApp: GitHubInstallationApp = { appId: "1", privateKey: signingKey };

function installation(id = 9, account = "acme") {
  return {
    id,
    app_id: 1,
    app_slug: "armada",
    account: { login: account, type: "Organization" },
    repository_selection: "all",
  };
}
function repo(id = 7, branch = "trunk", owner = "acme") {
  return { private: true, id, name: "web", default_branch: branch, owner: { login: owner } };
}

test("authorizes each requested repository with the caller token and returns IDs, default branches and the token", async () => {
  const calls: string[] = [];
  const adapter = goldenGitHubAdapter({
    app,
    accessToken: async () => "user-token",
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/user/installations")) return Response.json({ installations: [installation()] });
      return Response.json(repo());
    }) as typeof fetch,
  });
  await expect(adapter.authorize(actor, "org", ["acme/web"])).resolves.toEqual({
    repos: [{ owner: "acme", repo: "web", id: 7, installationId: 9, branch: "trunk" }],
    token: "user-token",
  });
  expect(calls).toContain("https://api.github.com/repos/acme/web");
});

test("refuses a repository GitHub does not let the caller read", async () => {
  const adapter = goldenGitHubAdapter({
    app,
    accessToken: async () => "user-token",
    fetch: (async (input: string | URL | Request) =>
      String(input).includes("/user/installations")
        ? Response.json({ installations: [installation()] })
        : new Response(null, { status: 404 })) as typeof fetch,
  });
  await expect(adapter.authorize(actor, "private", ["acme/web"])).rejects.toThrow("cannot access");
});

test("refuses a caller-visible repository without a caller-visible installation", async () => {
  const adapter = goldenGitHubAdapter({
    app,
    accessToken: async () => "user-token",
    fetch: (async (input: string | URL | Request) =>
      String(input).includes("/user/installations")
        ? Response.json({ installations: [installation(9, "elsewhere")] })
        : Response.json(repo())) as typeof fetch,
  });
  await expect(adapter.authorize(actor, "org", ["acme/web"])).rejects.toThrow("GitHub App installation");
});

test("permits caller-verified public repository without an App installation", async () => {
  const adapter = goldenGitHubAdapter({ app, accessToken: async () => "user-token", fetch: (async (input: string | URL | Request) =>
    String(input).includes("/user/installations") ? Response.json({ installations: [] }) : Response.json({ ...repo(), private: false })) as typeof fetch });
  await expect(adapter.authorize(actor, "org", ["octocat/Hello-World"])).resolves.toMatchObject({ repos: [{ installationId: 0 }], token: "user-token" });
});

test("still refuses caller-visible private repository without installation", async () => {
  const adapter = goldenGitHubAdapter({ app, accessToken: async () => "user-token", fetch: (async (input: string | URL | Request) =>
    String(input).includes("/user/installations") ? Response.json({ installations: [] }) : Response.json(repo())) as typeof fetch });
  await expect(adapter.authorize(actor, "org", ["acme/web"])).rejects.toThrow("GitHub App installation");
});

test("installation pagination is honored before authorization", async () => {
  const adapter = goldenGitHubAdapter({
    app,
    accessToken: async () => "user-token",
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("/user/installations")) return Response.json(repo());
      const page = new URL(url).searchParams.get("page");
      return Response.json({
        installations:
          page === "1" ? Array.from({ length: 100 }, (_, i) => installation(i + 1, "other")) : [installation()],
      });
    }) as typeof fetch,
  });
  const result = await adapter.authorize(actor, "org", ["acme/web"]);
  expect(result.repos).toHaveLength(1);
});

test("without an App no mint is offered: checkout falls back to the caller's own token", async () => {
  const adapter = goldenGitHubAdapter({
    app: null,
    accessToken: async () => "user-token",
    fetch: (async (input: string | URL | Request) =>
      String(input).includes("/user/installations")
        ? Response.json({ installations: [installation()] })
        : Response.json(repo())) as typeof fetch,
  });
  expect(adapter.mint).toBeUndefined();
  await expect(adapter.authorize(actor, "org", ["acme/web"])).resolves.toMatchObject({ token: "user-token" });
});

test("with an App, mint issues a scoped token independent of the caller's own, and revoke calls GitHub", async () => {
  const calls: string[] = [];
  const adapter = goldenGitHubAdapter({
    app: signedApp,
    accessToken: async () => "user-token",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_scoped", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      if (url.includes("/installation/token") && init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(null, { status: 500 });
    }) as typeof fetch,
  });
  expect(adapter.mint).toBeDefined();
  const issued = await adapter.mint?.(9, [7]);
  expect(issued?.token).toBe("ghs_scoped");
  expect(issued?.token).not.toBe("user-token");
  await issued?.revoke();
  expect(calls).toContain("DELETE https://api.github.com/installation/token");
});
