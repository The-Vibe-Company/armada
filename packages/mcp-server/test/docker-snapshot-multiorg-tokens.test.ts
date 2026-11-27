import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { DOCKER_HOST_PROTOCOL, type Sql, VERSION } from "@armada/core";
import {
  createSqlVaultStore,
  encryptSecret,
  type GitHubInstallationApp,
  parseDockerSnapshotTokens,
} from "@armada/core/server";
import type { Caller } from "../src/caller.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { createDockerSnapshots } from "../src/docker-snapshots.ts";
import { useMigratedDatabase } from "./migrated-database.ts";

const database = useMigratedDatabase();
const sql: Sql = {
  query: (q, v) => database().query(q, v),
  transaction: (work) => database().transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
};
const key = Buffer.alloc(32, 23).toString("base64");
const hosts = createDockerHostStore(sql, key);
const installationApp: GitHubInstallationApp = {
  appId: "42",
  privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
};
const OAUTH_TOKEN = "offline-broad-oauth-token";

interface FixtureOptions {
  installations?: { id: number; account: string }[];
  repos?: { id: number; owner: string; name: string; private: boolean; defaultBranch?: string }[];
  failMintForInstallation?: { installationId: number; status: number };
  failRevokeForToken?: string;
  sqlOverride?: Sql;
}

async function setupFixture(options: FixtureOptions = {}) {
  const db = database();
  const orgId = randomUUID();
  const userId = randomUUID();
  const hostId = randomUUID();
  const hostInstallationId = randomUUID();
  const hostToken = randomBytes(32).toString("hex");
  await db.query(
    `with u as (insert into auth.users(id) values($2)),
      o as (insert into public.orgs(id,name) values($1,$3)),
      m as (insert into public.members(org_id,user_id,role) values($1,$2,'admin'))
     insert into public.docker_hosts(
       id,org_id,owner_id,registration_expires_at,installation_id,hash,last_seen_at,daemon_version,daemon_protocol
     ) values($4,$1,$2,now()+interval '5 minutes',$5,$6,now(),$7,$8)`,
    [
      orgId,
      userId,
      `multiorg-snap-${orgId}`,
      hostId,
      hostInstallationId,
      createHash("sha256").update(hostToken).digest("hex"),
      VERSION,
      DOCKER_HOST_PROTOCOL,
    ],
  );
  const [refreshEnc, accessEnc] = await Promise.all([
    encryptSecret("offline-refresh-token", key),
    encryptSecret(OAUTH_TOKEN, key),
  ]);
  await db.query(
    `insert into public.github_connections
      (user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at)
     values ($1,777,'octo','Octo',$2,$3,now()+interval '2 hours')`,
    [userId, refreshEnc, accessEnc],
  );

  const installations = options.installations ?? [
    { id: 101, account: "acme-org" },
    { id: 202, account: "beta-org" },
  ];
  const repos = options.repos ?? [
    { id: 1001, owner: "acme-org", name: "web", private: true, defaultBranch: "main" },
    { id: 1002, owner: "acme-org", name: "api", private: true, defaultBranch: "main" },
    { id: 2001, owner: "beta-org", name: "core", private: true, defaultBranch: "trunk" },
  ];
  const minted: { installationId: number; repositoryIds: number[]; permissions: unknown; token: string }[] = [];
  const revoked: string[] = [];
  let mintSeq = 0;

  const githubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/user/installations")) {
      return Response.json({
        installations: installations.map((inst) => ({
          id: inst.id,
          app_id: Number(installationApp.appId),
          app_slug: "armada",
          account: { login: inst.account, type: "Organization" },
          repository_selection: "all",
        })),
      });
    }
    const repoMatch = /\/repos\/([^/]+)\/([^/?]+)$/.exec(url);
    if (repoMatch) {
      const owner = decodeURIComponent(repoMatch[1]!);
      const name = decodeURIComponent(repoMatch[2]!);
      const found = repos.find(
        (r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase(),
      );
      if (!found) return new Response(null, { status: 404 });
      return Response.json({
        id: found.id,
        name: found.name,
        owner: { login: found.owner },
        private: found.private,
        default_branch: found.defaultBranch ?? "main",
      });
    }
    const mintMatch = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
    if (method === "POST" && mintMatch) {
      const installationId = Number(mintMatch[1]);
      if (options.failMintForInstallation?.installationId === installationId) {
        return Response.json({ message: "refused" }, { status: options.failMintForInstallation.status });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { repository_ids?: number[]; permissions?: unknown };
      const token = `scoped-inst-${installationId}-${++mintSeq}`;
      minted.push({ installationId, repositoryIds: body.repository_ids ?? [], permissions: body.permissions, token });
      return Response.json({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (method === "DELETE" && url.endsWith("/installation/token")) {
      const token = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (options.failRevokeForToken === token) return new Response(null, { status: 500 });
      revoked.push(token);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/user")) return Response.json({ id: 777, login: "octo", name: "Octo" });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  const activeSql = options.sqlOverride ?? sql;
  const snapshots = createDockerSnapshots(activeSql, key, {
    enabled: true,
    github: {
      store: createSqlVaultStore(activeSql),
      app: { clientId: "offline-app", clientSecret: "offline-app-secret" },
      encryptionKey: key,
      fetch: githubFetch,
    },
    installationApp,
  });
  const caller: Caller = { userId, orgs: [{ orgId, role: "admin" }], via: "supabase" };
  return { orgId, hostId, hostInstallationId, hostToken, caller, snapshots, minted, revoked };
}

test("multi-org snapshot create and rebuild mint per-org scoped tokens without OAuth fallback", async () => {
  const f = await setupFixture();
  const requestId = randomUUID();
  const created = await f.snapshots.command(f.caller, "create", {
    org: f.orgId,
    hostId: f.hostId,
    requestId,
    name: "multi-org-snap",
    visibility: "org",
    config: {
      repos: [
        { url: "https://github.com/acme-org/web.git" },
        { url: "https://github.com/acme-org/api.git" },
        { url: "https://github.com/beta-org/core.git" },
      ],
      init: [],
    },
  });

  expect(created).toMatchObject({ snapshot: { id: requestId, status: "building" } });
  expect(JSON.stringify(created)).not.toContain(OAUTH_TOKEN);
  expect(f.minted).toEqual([
    { installationId: 101, repositoryIds: [1001, 1002], permissions: { contents: "read" }, token: "scoped-inst-101-1" },
    { installationId: 202, repositoryIds: [2001], permissions: { contents: "read" }, token: "scoped-inst-202-2" },
  ]);
  expect(f.revoked).toEqual([]);

  const polled = await hosts.poll(f.hostToken, f.hostInstallationId, VERSION);
  if (polled?.operation !== "buildSnapshot") throw new Error("Expected queued buildSnapshot job");
  expect(polled.build.token).not.toContain(OAUTH_TOKEN);
  expect(parseDockerSnapshotTokens(polled.build.token)).toEqual({
    mode: "scoped",
    tokens: ["scoped-inst-101-1", "scoped-inst-202-2"],
    scopes: { "acme-org/web": 0, "acme-org/api": 0, "beta-org/core": 1 },
  });

  await hosts.complete(f.hostToken, f.hostInstallationId, {
    requestId,
    outcome: "completed",
    imageId: `sha256:${"c".repeat(64)}`,
    baselineVersion: 1,
  });
  await f.snapshots.command(f.caller, "rebuild", { org: f.orgId, id: requestId, requestId: randomUUID() });
  const rebuiltJob = await hosts.poll(f.hostToken, f.hostInstallationId, VERSION);
  if (rebuiltJob?.operation !== "buildSnapshot") throw new Error("Expected rebuilt buildSnapshot job");
  expect(rebuiltJob.build.token).not.toContain(OAUTH_TOKEN);
  expect(parseDockerSnapshotTokens(rebuiltJob.build.token)).toEqual({
    mode: "scoped",
    tokens: ["scoped-inst-101-3", "scoped-inst-202-4"],
    scopes: { "acme-org/web": 0, "acme-org/api": 0, "beta-org/core": 1 },
  });
});

test("mixed private org installation and public repository scopes the installation token separately", async () => {
  const f = await setupFixture({
    installations: [{ id: 101, account: "acme-org" }],
    repos: [
      { id: 1001, owner: "acme-org", name: "web", private: true },
      { id: 3001, owner: "public-org", name: "oss", private: false },
    ],
  });
  await f.snapshots.command(f.caller, "create", {
    org: f.orgId,
    hostId: f.hostId,
    requestId: randomUUID(),
    name: "mixed-snap",
    config: {
      repos: [{ url: "https://github.com/acme-org/web.git" }, { url: "https://github.com/public-org/oss.git" }],
      init: [],
    },
  });
  const polled = await hosts.poll(f.hostToken, f.hostInstallationId, VERSION);
  if (polled?.operation !== "buildSnapshot") throw new Error("Expected queued buildSnapshot job");
  expect(parseDockerSnapshotTokens(polled.build.token)).toEqual({
    mode: "scoped",
    tokens: ["scoped-inst-101-1", OAUTH_TOKEN],
    scopes: { "acme-org/web": 0, "public-org/oss": 1 },
  });
});

test.each([
  { status: 403, expectedCode: "forbidden" },
  { status: 502, expectedCode: "unavailable" },
])(
  "partial mint failure ($status) refuses without OAuth fallback and revokes already-minted tokens",
  async ({ status, expectedCode }) => {
    const f = await setupFixture({ failMintForInstallation: { installationId: 202, status } });
    await expect(
      f.snapshots.command(f.caller, "create", {
        org: f.orgId,
        hostId: f.hostId,
        requestId: randomUUID(),
        name: "partial-mint-fail",
        config: {
          repos: [{ url: "https://github.com/acme-org/web.git" }, { url: "https://github.com/beta-org/core.git" }],
          init: [],
        },
      }),
    ).rejects.toMatchObject({ code: expectedCode });
    expect(f.minted.map((m) => m.token)).toEqual(["scoped-inst-101-1"]);
    expect(f.revoked).toEqual(["scoped-inst-101-1"]);
    expect(await hosts.poll(f.hostToken, f.hostInstallationId, VERSION)).toBeNull();
  },
);

test("dispatch failure after minting revokes every minted installation token", async () => {
  const f = await setupFixture();
  await f.snapshots.command(f.caller, "create", {
    org: f.orgId,
    hostId: f.hostId,
    requestId: randomUUID(),
    name: "active-build",
    config: { repos: [{ url: "https://github.com/acme-org/web.git" }], init: [] },
  });
  f.minted.length = 0;

  await expect(
    f.snapshots.command(f.caller, "create", {
      org: f.orgId,
      hostId: f.hostId,
      requestId: randomUUID(),
      name: "blocked-multiorg",
      config: {
        repos: [{ url: "https://github.com/acme-org/web.git" }, { url: "https://github.com/beta-org/core.git" }],
        init: [],
      },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.minted.map((m) => m.token)).toEqual(["scoped-inst-101-2", "scoped-inst-202-3"]);
  expect(f.revoked).toEqual(["scoped-inst-101-2", "scoped-inst-202-3"]);
});

test("revocation failure on first token does not block revoking remaining tokens on admission failure", async () => {
  const failingSql: Sql = {
    query: (q, v) => sql.query(q, v),
    transaction: async () => {
      throw new Error("simulated admission failure");
    },
  };
  const f = await setupFixture({ failRevokeForToken: "scoped-inst-101-1", sqlOverride: failingSql });
  await expect(
    f.snapshots.command(f.caller, "create", {
      org: f.orgId,
      hostId: f.hostId,
      requestId: randomUUID(),
      name: "revoke-resilience",
      config: {
        repos: [{ url: "https://github.com/acme-org/web.git" }, { url: "https://github.com/beta-org/core.git" }],
        init: [],
      },
    }),
  ).rejects.toThrow("simulated admission failure");
  expect(f.minted.map((m) => m.token)).toEqual(["scoped-inst-101-1", "scoped-inst-202-2"]);
  expect(f.revoked).toEqual(["scoped-inst-202-2"]);
});

test("concurrent replay hitting existing row inside transaction revokes unused newly minted tokens", async () => {
  const requestId = randomUUID();
  let hideInitialRead = true;
  let racingInsert: (() => Promise<void>) | undefined;
  const raceSql: Sql = {
    async query<T>(q: string, v?: unknown[]) {
      if (hideInitialRead && q.includes("from public.docker_snapshots s") && v?.[2] === requestId) {
        hideInitialRead = false;
        return { rows: [] as T[] };
      }
      return sql.query<T>(q, v);
    },
    transaction: async (work) => {
      if (racingInsert) {
        const run = racingInsert;
        racingInsert = undefined;
        await run();
      }
      return sql.transaction!(work);
    },
  };
  const f = await setupFixture({ sqlOverride: raceSql });
  const input = {
    org: f.orgId,
    hostId: f.hostId,
    requestId,
    name: "concurrent-replay",
    config: {
      repos: [{ url: "https://github.com/acme-org/web.git" }, { url: "https://github.com/beta-org/core.git" }],
      init: [],
    },
  };
  const winner = createDockerSnapshots(sql, key, {
    enabled: true,
    github: {
      store: createSqlVaultStore(sql),
      app: { clientId: "offline-app", clientSecret: "offline-app-secret" },
      encryptionKey: key,
      fetch: (async (url: string | URL | Request) => {
        const s = String(url);
        if (s.includes("/user/installations")) return Response.json({ installations: [] });
        if (s.endsWith("/repos/acme-org/web"))
          return Response.json({
            id: 1001,
            name: "web",
            owner: { login: "acme-org" },
            private: false,
            default_branch: "main",
          });
        if (s.endsWith("/repos/beta-org/core"))
          return Response.json({
            id: 2001,
            name: "core",
            owner: { login: "beta-org" },
            private: false,
            default_branch: "trunk",
          });
        if (s.endsWith("/user")) return Response.json({ id: 777, login: "octo", name: "Octo" });
        return new Response(null, { status: 404 });
      }) as unknown as typeof fetch,
    },
    installationApp: null,
  });
  racingInsert = async () => {
    await winner.command(f.caller, "create", input);
  };

  const replayed = await f.snapshots.command(f.caller, "create", input);
  expect(replayed).toMatchObject({ snapshot: { id: requestId, status: "building" } });
  expect(f.minted.map((m) => m.token)).toEqual(["scoped-inst-101-1", "scoped-inst-202-2"]);
  expect(f.revoked).toEqual(["scoped-inst-101-1", "scoped-inst-202-2"]);
});

test("single-org snapshot keeps single-token mode for backward daemon compatibility", async () => {
  const f = await setupFixture();
  await f.snapshots.command(f.caller, "create", {
    org: f.orgId,
    hostId: f.hostId,
    requestId: randomUUID(),
    name: "single-org-snap",
    config: {
      repos: [{ url: "https://github.com/acme-org/web.git" }, { url: "https://github.com/acme-org/api.git" }],
      init: [],
    },
  });
  const polled = await hosts.poll(f.hostToken, f.hostInstallationId, VERSION);
  if (polled?.operation !== "buildSnapshot") throw new Error("Expected queued buildSnapshot job");
  expect(polled.build.token).toBe("scoped-inst-101-1");
  expect(parseDockerSnapshotTokens(polled.build.token)).toEqual({ mode: "single", token: "scoped-inst-101-1" });
});
