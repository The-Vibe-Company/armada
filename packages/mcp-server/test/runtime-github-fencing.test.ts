import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PROTOCOL_VERSION } from "@armada/agent-runtime";
import { encryptSecret, type GitHubConnectionStore, type Sql } from "@armada/core/server";
import { GitHubBroker } from "../../agent-runtime/src/github-broker.ts";
import { createRuntimeGitHub } from "../src/runtime-github.ts";
import { ENCRYPTION_KEY } from "./support.ts";

// The broker boundary needs stored rows, not a migrated database, guest journal,
// initial agent turn or filesystem. SQL visibility/locking and durable command ACKs
// remain owned by their database/runtime tests; this fake supplies only row results.
test.each(["boat", "modal", "docker"] as const)(
  "runtime GitHub broker fences repository and epoch changes during credential acquisition (%s)",
  async (provider) => {
    const binding = {
      sandboxId: "sandbox",
      ownerId: "owner",
      orgId: "org",
      epoch: "1",
      githubId: 123,
      repositories: [{ url: "https://github.com/example/web.git" }],
    };
    const capability = `armada_gh_${"a".repeat(64)}`;
    const access = "offline_access";
    let epoch = "1",
      acquisitions = 0,
      userRequests = 0;
    let duringUserRequest = () => {};
    const cap = {
      sandbox_id: binding.sandboxId,
      epoch: "1",
      revision: "1",
      binding,
      acquisition_count: "0",
      delivered_at: "delivered",
      last_accessed_at: null,
    };
    const sql: Sql = {
      async query<T>(query: string, values?: unknown[]) {
        let rows: unknown[];
        if (query.includes("from public.runtime_github_capabilities")) {
          expect(values?.[0]).toBe(createHash("sha256").update(capability).digest("hex"));
          rows = [cap];
        } else if (query.includes("select m.user_id,s.id")) {
          rows = [
            {
              user_id: "owner",
              id: "sandbox",
              owner_id: "owner",
              org_id: "org",
              provider,
              issuer_id: "owner",
              docker_host_id: "host",
              docker_installation_id: "installation",
            },
          ];
        } else if (query.includes("from public.mcp_actor_epochs")) rows = [{ epoch: "1" }];
        else if (query.includes("from public.docker_hosts")) rows = [{ id: "host" }];
        else if (query.includes("select s.id,s.lifecycle_generation"))
          rows = [{ id: "sandbox", lifecycle_generation: "1" }];
        else if (query.includes("from public.runtime_enrolments"))
          rows = [{ epoch, runtime_protocol_version: PROTOCOL_VERSION }];
        else if (query.includes("jsonb_build_object"))
          rows = [{ binding: { ...binding, epoch }, expires_at: "2099-01-01" }];
        else if (query.includes("from public.docker_launch_requests")) rows = [];
        else if (query.includes("insert into public.github_runtime_issued")) rows = [];
        else if (query.includes("update runtime_github_capabilities")) {
          acquisitions++;
          rows = [];
        } else throw Error(`Unexpected SQL: ${query}`);
        return { rows: rows as T[] };
      },
      transaction: (work) => work(sql),
    };
    const connection = {
      userId: "owner",
      githubId: 123,
      login: "owner",
      name: "Owner",
      revokedAt: null,
      refreshTokenEnc: await encryptSecret("offline_refresh", ENCRYPTION_KEY),
      refreshExpiresAt: null,
      accessTokenEnc: await encryptSecret(access, ENCRYPTION_KEY),
      accessExpiresAt: new Date("2099-01-01"),
    };
    const unexpected = async (): Promise<never> => {
      throw Error("No refresh should be needed");
    };
    const store: GitHubConnectionStore = {
      async getGitHubConnection() {
        return connection;
      },
      async withGitHubConnectionRefresh(userId, work) {
        expect(userId).toBe("owner");
        return work(store, connection);
      },
      consumeGitHubRefresh: unexpected,
      rotateGitHubToken: unexpected,
      markGitHubRevoked: unexpected,
      async updateGitHubProfile() {},
    };
    const service = createRuntimeGitHub({
      sql,
      key: ENCRYPTION_KEY,
      origin: "https://armada.test",
      commands: { execute: unexpected } as unknown as Parameters<typeof createRuntimeGitHub>[0]["commands"],
      github: {
        store,
        encryptionKey: ENCRYPTION_KEY,
        app: { clientId: "app", clientSecret: "offline_secret" },
        now: () => new Date("2026-01-01"),
        fetch: (async () => {
          userRequests++;
          duringUserRequest();
          return Response.json({ id: 123, login: "owner", name: "Owner" });
        }) as unknown as typeof fetch,
      },
    });
    const secrets = new Set<string>();
    const broker = new GitHubBroker(
      (values) => {
        for (const value of values) secrets.add(value);
      },
      (async (url, options) => (await service.route(new Request(String(url), options)))!) as typeof fetch,
    );
    broker.configure({
      version: 1,
      revision: "1",
      generation: "1",
      capability,
      url: "https://armada.test/api/runtime/github/credentials",
      expiresAt: Date.now() + 60000,
    });
    expect(await broker.acquire("example/web", "gh")).toBe(access);
    expect(secrets.has(access)).toBe(true);
    expect(acquisitions).toBe(1);
    await expect(broker.acquire("foreign/repo", "gh")).rejects.toThrow();
    expect(userRequests).toBe(1);
    duringUserRequest = () => {
      epoch = "2";
    };
    await expect(broker.acquire("example/web", "git")).rejects.toThrow();
    expect(userRequests).toBe(2);
    expect(acquisitions).toBe(1);
    await expect(broker.acquire("example/web", "gh")).rejects.toThrow();
    expect(userRequests).toBe(2);
  },
);
