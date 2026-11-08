import { expect, test } from "bun:test";
import { type GitHubInstallationApp, goldenGitHubAdapter } from "../src/index.ts";

const actor = { userId: "u", orgId: "o", role: "admin" } as const;
const app: GitHubInstallationApp = { appId: "1", privateKey: "bad key" };

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
  return { id, name: "web", default_branch: branch, owner: { login: owner } };
}

test("authorizes each requested repository with the caller token and returns IDs and default branches", async () => {
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
  await expect(adapter.authorize(actor, "org", ["acme/web"])).resolves.toEqual([
    { owner: "acme", repo: "web", id: 7, installationId: 9, branch: "trunk" },
  ]);
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
  await expect(adapter.authorize(actor, "org", ["acme/web"])).resolves.toHaveLength(1);
});

test("missing App server credentials refuse minting explicitly", async () => {
  const adapter = goldenGitHubAdapter({ app: null, accessToken: async () => "user-token" });
  await expect(adapter.mint(9, [7])).rejects.toThrow("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY");
});
