import { expect, test } from "bun:test";
import { encryptSecret, type GitHubConnectionStore, type StoredGitHubConnection } from "@armada/core/server";
import { createRuntimeGitHub, RuntimeGitHubConnectionError } from "../src/runtime-github.ts";

test("service-token repository preflight uses only its linked user's GitHub connection", async () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const key = btoa("a".repeat(32));
  const token = "offline_user_access";
  let connection: StoredGitHubConnection | null = {
    userId: "linked_user",
    githubId: 123,
    login: "owner",
    name: "Owner",
    refreshTokenEnc: await encryptSecret("offline_refresh", key),
    refreshExpiresAt: null,
    revokedAt: null,
    accessTokenEnc: await encryptSecret(token, key),
    accessExpiresAt: new Date("2026-01-02T00:00:00Z"),
  };
  const users: string[] = [];
  const unexpected = async (): Promise<never> => {
    throw Error("Unexpected credential store operation");
  };
  const store: GitHubConnectionStore = {
    async getGitHubConnection(userId) {
      users.push(userId);
      return userId === "linked_user" ? connection : null;
    },
    consumeGitHubRefresh: unexpected,
    rotateGitHubToken: unexpected,
    markGitHubRevoked: unexpected,
    async updateGitHubProfile() {},
    async withGitHubConnectionRefresh(userId, work) {
      users.push(userId);
      return work(store, userId === "linked_user" ? connection : null);
    },
  };
  const requests: string[] = [];
  const service = createRuntimeGitHub({
    sql: { query: unexpected, transaction: unexpected },
    key,
    origin: "https://armada.test",
    // Repository admission must not deliver commands or start a runtime.
    commands: {} as Parameters<typeof createRuntimeGitHub>[0]["commands"],
    github: {
      store,
      encryptionKey: key,
      app: { clientId: "offline_app", clientSecret: "offline_secret" },
      now: () => now,
      fetch: (async (input, init) => {
        const url = String(input);
        requests.push(url);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
        if (url === "https://api.github.com/user") return Response.json({ id: 123, login: "owner", name: "Owner" });
        if (url === "https://api.github.com/repos/example/web") return Response.json({ full_name: "example/web" });
        throw Error(`Unexpected GitHub request: ${url}`);
      }) as typeof fetch,
    },
  });
  const caller = {
    userId: "linked_user",
    orgs: [{ orgId: "org_with_installation", role: "member" as const }],
    via: "service" as const,
  };
  const repos = [{ url: "https://github.com/example/web.git" }];
  await service.preflightRepositories(caller, "org_with_installation", repos);
  expect(requests).toEqual(["https://api.github.com/user", "https://api.github.com/repos/example/web"]);
  connection = null;
  requests.length = 0;
  await expect(service.preflightRepositories(caller, "org_with_installation", repos)).rejects.toBeInstanceOf(
    RuntimeGitHubConnectionError,
  );
  expect(users).toEqual(["linked_user", "linked_user", "linked_user"]);
  expect(requests).toEqual([]);
});
