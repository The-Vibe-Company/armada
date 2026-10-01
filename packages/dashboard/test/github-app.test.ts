import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { fetchForge, GITHUB_GRAPHQL } from "@armada/core/read";
import type { Database } from "../lib/db.ts";
import {
  appJwt,
  createGithubApp,
  type Fetch,
  GITHUB_API,
  type GithubAppSettings,
  githubAppModeOf,
  linkedInstallations,
  linkInstallation,
  RENEW_BEFORE_MS,
  repositoryToken,
  unlinkInstallation,
  userInstallations,
} from "../lib/github-app.ts";
import { addOrganizations, tempDatabase } from "./support.ts";

// A throwaway key made for this run, synthetic accounts and repositories: no real app's keys.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const ENV = { ARMADA_GITHUB_APP_ID: "424242", ARMADA_GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, "\\n") };
const mode = githubAppModeOf(ENV);
const settings = (mode.kind === "on" ? mode.settings : null) as GithubAppSettings;
const start = new Date("2026-10-01T09:00:00Z");

interface Call {
  method: string;
  url: string;
  authorization: string;
}

/**
 * Plays GitHub for the app: acme/private-repo and acme/other are covered by
 * installation 11 (on acme), nothing else is. Each mint hands out a new token
 * that lasts an hour from `now()`. The GraphQL API answers only to the
 * installation's current token, with a check run on the open pull request.
 */
function fakeGithub(now: () => Date) {
  const calls: Call[] = [];
  let minted = 0;
  let current = "";
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    calls.push({ method, url, authorization });
    const app = authorization.startsWith("Bearer ey");
    if (url === `${GITHUB_API}/app` && app)
      return Response.json({ name: "Armada", html_url: "https://github.com/apps/armada-synthetic" });
    if (/\/repos\/acme\/(private-repo|other)\/installation$/.test(url) && app)
      return Response.json({ id: 11, account: { login: "acme" } });
    if (url.endsWith("/installation") && app) return Response.json({ message: "Not Found" }, { status: 404 });
    if (url === `${GITHUB_API}/app/installations/11/access_tokens` && method === "POST" && app) {
      current = `ghs_synthetic_${++minted}`;
      return Response.json(
        { token: current, expires_at: new Date(now().getTime() + 3_600_000).toISOString() },
        { status: 201 },
      );
    }
    if (url === `${GITHUB_API}/user/installations?per_page=100` && authorization === "Bearer ghu_synthetic_person")
      return Response.json({ total_count: 1, installations: [{ id: 11, account: { login: "acme" } }] });
    if (url === GITHUB_GRAPHQL) {
      if (authorization !== `Bearer ${current}`) return Response.json({ message: "Bad credentials" }, { status: 401 });
      return Response.json({
        data: { repository: { open: { nodes: [pull()], pageInfo: { hasNextPage: false } }, closed: { nodes: [] } } },
      });
    }
    return Response.json({ message: "Bad credentials" }, { status: 401 });
  };
  return { fetch, calls, minted: () => minted };
}

function pull() {
  return {
    number: 7,
    title: "Add the synthetic feature",
    url: "https://github.com/acme/private-repo/pull/7",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headRefName: "feature/abc-7-synthetic",
    headRefOid: "a".repeat(40),
    createdAt: "2026-10-01T08:00:00Z",
    updatedAt: "2026-10-01T08:30:00Z",
    mergedAt: null,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: "FAILURE",
              contexts: {
                nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
              },
            },
          },
        },
      ],
    },
  };
}

describe("the app's settings", () => {
  test("off with neither variable; invalid with a bad id or key, without quoting the key; on with a key pasted on one line", () => {
    expect(githubAppModeOf({})).toEqual({ kind: "off" });
    expect(githubAppModeOf({ ...ENV, ARMADA_GITHUB_APP_ID: "armada" })).toMatchObject({ kind: "invalid" });
    const bad = githubAppModeOf({ ...ENV, ARMADA_GITHUB_APP_PRIVATE_KEY: "not a key" });
    expect(bad).toMatchObject({ kind: "invalid" });
    expect(JSON.stringify(bad)).not.toContain("not a key");
    expect(githubAppModeOf({ ARMADA_GITHUB_APP_ID: "424242" })).toMatchObject({ kind: "invalid" });
    expect(mode.kind).toBe("on");
  });

  test("the app's token is an RS256 JSON Web Token GitHub can check with the app's public key", () => {
    const jwt = appJwt(settings, start);
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(createPublicKey(privateKey), Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
    const at = start.getTime() / 1000;
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iat: at - 60,
      exp: at + 540,
      iss: "424242",
    });
  });
});

describe("reading a private repository through the app", () => {
  test("the installation's token reads the pull requests with their check runs; no GitHub token is set", async () => {
    let now = start;
    const github = fakeGithub(() => now);
    const app = createGithubApp({ settings, fetch: github.fetch, now: () => now });

    const read = await repositoryToken(app, { kind: "any" }, null, "acme/private-repo");
    expect(read.token).toBe("ghs_synthetic_1");
    const forge = await fetchForge({ token: read.token ?? "", repository: "acme/private-repo", fetch: github.fetch });
    expect(forge.prs[0]).toMatchObject({ number: 7, ci: "failure", checks: [{ name: "test", state: "failure" }] });

    // The installation and its token are kept: a second repository of the same account costs one lookup.
    expect((await repositoryToken(app, { kind: "any" }, null, "acme/other")).token).toBe("ghs_synthetic_1");
    await repositoryToken(app, { kind: "any" }, null, "acme/private-repo");
    expect(github.minted()).toBe(1);
    expect(github.calls.filter((c) => c.url.endsWith("/installation"))).toHaveLength(2);

    // Close to its expiry the token is minted again, once for concurrent reads.
    now = new Date(start.getTime() + 3_600_000 - RENEW_BEFORE_MS + 1);
    const again = await Promise.all([app.tokenFor(11), app.tokenFor(11), app.tokenFor(11)]);
    expect(again).toEqual(["ghs_synthetic_2", "ghs_synthetic_2", "ghs_synthetic_2"]);
    expect(github.minted()).toBe(2);
    expect(await app.info()).toEqual({ name: "Armada", url: "https://github.com/apps/armada-synthetic" });
  });

  test("an organization reads only through the installations linked to it; without one, a stored token, else the reason", async () => {
    const github = fakeGithub(() => start);
    const app = createGithubApp({ settings, fetch: github.fetch, now: () => start });
    const linked = (...ids: number[]) => ({ kind: "linked" as const, installations: new Set(ids) });

    expect((await repositoryToken(app, linked(11), null, "acme/private-repo")).token).toBe("ghs_synthetic_1");
    expect(await repositoryToken(app, linked(99), null, "acme/private-repo")).toEqual({
      token: null,
      reason: "the Armada GitHub App's installation on acme is not linked to this organization (Organization > GitHub)",
    });
    expect(await repositoryToken(app, { kind: "any" }, null, "elsewhere/repo")).toEqual({
      token: null,
      reason: "the Armada GitHub App is not installed on elsewhere/repo",
    });
    expect((await repositoryToken(app, linked(), "ghp_synthetic_stored", "acme/private-repo")).token).toBe(
      "ghp_synthetic_stored",
    );
    expect((await repositoryToken(null, { kind: "any" }, null, "acme/private-repo")).reason).toContain(
      "ARMADA_GITHUB_APP_ID",
    );
    // A refusal names the call, never a token.
    const refused = createGithubApp({
      settings,
      fetch: async () => Response.json({ message: "Bad credentials" }, { status: 401 }),
    });
    const why = await repositoryToken(refused, { kind: "any" }, null, "acme/private-repo");
    expect(why.reason).toBe("GitHub answered HTTP 401 finding the app's installation on acme/private-repo");
  });
});

describe("linking installations", () => {
  let client: Database;
  beforeAll(async () => {
    client = await tempDatabase();
    await addOrganizations(client, "org-a", "org-b");
  });
  afterAll(() => client.end());

  test("an installation is linked only when GitHub shows it to the person; unlinking touches only that organization", async () => {
    const github = fakeGithub(() => start);
    const reachable = await userInstallations(github.fetch, "ghu_synthetic_person");
    expect(reachable).toEqual([{ id: 11, account: "acme" }]);
    await expect(userInstallations(github.fetch, "ghu_synthetic_stranger")).rejects.toThrow("HTTP 401");

    const by = { id: "user-1", label: "Synthetic Owner <owner@example.test>" };
    const link = (organization: string, installation: number) =>
      linkInstallation(client, { organization, installation, reachable, by, now: start });
    expect(await link("org-a", 99)).toBe("unreachable");
    expect(await link("org-a", 11)).toBe("linked");
    expect(await link("org-a", 11)).toBe("already");
    expect(await link("org-b", 11)).toBe("linked");
    expect(await linkedInstallations(client, "org-a")).toEqual([
      { id: 11, account: "acme", linkedBy: by.label, linkedAt: start.toISOString() },
    ]);

    expect(await unlinkInstallation(client, "org-a", 11)).toBe(true);
    expect(await unlinkInstallation(client, "org-a", 11)).toBe(false);
    expect(await linkedInstallations(client, "org-a")).toEqual([]);
    expect((await linkedInstallations(client, "org-b")).map((i) => i.id)).toEqual([11]);
  });
});
