import { expect, test } from "bun:test";
import type { CredentialReader, GitHubConnectionStore, HarnessCredentials } from "@armada/core";
import { encryptSecret } from "@armada/core/server";
import { launchCredentials } from "../src/launch-credentials.ts";

const actor = { userId: "caller", orgId: "org", role: "member" as const };
const repository = { url: "https://github.com/acme/private.git", branch: "feature/work", dir: "private" };
const connected: HarnessCredentials = {
  env: {},
  secrets: [],
  codexAuthJson: false,
  github: {
    status: "connected",
    token: "caller_fixture_only",
    identity: { id: 7, login: "caller", name: "Caller", email: "caller@example.com" },
  },
};
const anonymous: HarnessCredentials = {
  env: {},
  secrets: [],
  codexAuthJson: false,
  github: { status: "not_connected", message: "Connect GitHub" },
};

test.each([
  "public",
  "private-no-connection",
  "contents-denied",
  "contents-allowed",
  "unknown-anonymous",
  "metadata-rate-limit",
  "contents-rate-limit",
])("repository preflight uses only caller access and distinguishes %s", async (mode) => {
  const requests: { url: string; authorization: string | null }[] = [];
  const credentials = ["contents-denied", "contents-allowed", "metadata-rate-limit", "contents-rate-limit"].includes(
    mode,
  )
    ? connected
    : anonymous;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (mode === "metadata-rate-limit") return Response.json({}, { status: 403, headers: { "retry-after": "1" } });
    if (mode === "unknown-anonymous") throw Error("Synthetic transport unavailable");
    if (mode === "private-no-connection") return Response.json({ message: "opaque server detail" }, { status: 404 });
    if (url.includes("/git/ref/") && mode === "contents-rate-limit")
      return Response.json({}, { status: 403, headers: { "retry-after": "1" } });
    if (url.includes("/git/ref/")) return Response.json({}, { status: mode === "contents-denied" ? 403 : 200 });
    return Response.json({ private: mode !== "public" });
  }) as typeof fetch;
  const resolver = launchCredentials({} as CredentialReader, undefined, {
    store: {} as GitHubConnectionStore,
    app: null,
    fetch: fetchImpl,
  });
  const result = resolver.authorizeRepositories!(actor, credentials, [repository]);
  if (["private-no-connection", "contents-denied", "unknown-anonymous"].includes(mode))
    await expect(result).rejects.toMatchObject({
      code: "no_credentials",
      message: expect.stringContaining("armada github connect"),
    });
  else await result;
  expect(
    requests.every((r) => r.authorization === (credentials === connected ? "Bearer caller_fixture_only" : null)),
  ).toBe(true);
  expect(requests.every((r) => !r.url.includes("caller_fixture_only"))).toBe(true);
  if (mode === "contents-allowed") expect(requests[1]?.url).toContain("/git/ref/heads/feature%2Fwork");
});

test("runtime-only repository preflight resolves access without putting a token into harness state", async () => {
  const key = Buffer.alloc(32, 21).toString("base64");
  const connection = {
    userId: "caller",
    githubId: 7,
    login: "caller",
    name: null,
    refreshTokenEnc: await encryptSecret("refresh_fixture_only", key),
    refreshExpiresAt: null,
    revokedAt: null,
    accessTokenEnc: await encryptSecret("caller_fixture_only", key),
    accessExpiresAt: new Date(Date.now() + 8 * 3600_000),
  };
  const store = {
    withGitHubConnectionRefresh: async (_id: string, work: any) => work(store, connection),
    getGitHubConnection: async () => connection,
    updateGitHubProfile: async () => {},
  } as unknown as GitHubConnectionStore;
  const credentials: HarnessCredentials = { env: { MODEL: "fixture_only" }, secrets: [], codexAuthJson: false };
  const resolver = launchCredentials({} as CredentialReader, key, undefined, undefined, {
    store,
    app: { clientId: "fixture", clientSecret: "fixture" },
    fetch: (async (input: string | URL | Request) =>
      String(input) === "https://api.github.com/user"
        ? Response.json({ id: 7, login: "caller", name: null })
        : Response.json({ private: false })) as typeof fetch,
  });
  await resolver.authorizeRepositories!(actor, credentials, [repository]);
  expect(credentials).toEqual({ env: { MODEL: "fixture_only" }, secrets: [], codexAuthJson: false });
});
