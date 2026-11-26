import { describe, expect, spyOn, test } from "bun:test";
import { sandboxCheckOperations } from "@armada/core/contract";
import { createSqlVaultStore, encryptSecret, type GitHubRuntimeConfiguration, type Sql } from "@armada/core/server";
import { GitHubBroker } from "../../agent-runtime/src/github-broker.ts";
import { type ControlOptions, dispatchControlCommand } from "../src/control.ts";
import { dockerLaunchRequestHash } from "../src/docker-launch-identity.ts";
import { enqueueLaunch } from "../src/jobs/launch.ts";
import { createJobsStore, recordDockerLaunchEvidence } from "../src/jobs/store.ts";
import { continueRequest } from "../src/request-observability.ts";
import { createRuntimeCheckpoint } from "../src/runtime-checkpoint.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeGitHub } from "../src/runtime-github.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { configureRuntimeFixture, runtimeFixture, scopedRuntimeFixture } from "./runtime.fixture.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function fixture(
  provider: "boat" | "modal" = "boat",
  options: {
    now?: () => number;
    commandGrantExpiresAt?: number;
    idle?: boolean;
    githubFetch?: typeof fetch;
    sibling?: NonNullable<Parameters<typeof runtimeFixture>[0]> & { access: string; goldenId: string };
  } = {},
) {
  const f = await runtimeFixture(
    options.sibling ?? (await sharedDatabase()),
    provider,
    "codex",
    options.idle,
    options.commandGrantExpiresAt,
    options.sibling ? { goldenId: options.sibling.goldenId, providerSandboxId: "sibling-physical" } : undefined,
  );
  return configureRuntimeFixture(f, async () => {
    const access = options.sibling?.access ?? `ghu_offline_${crypto.randomUUID().replaceAll("-", "")}`;
    await f.db.query("update sandboxes set expires_at=now()+interval '45 seconds' where id=$1", [f.row.id]);
    if (!options.sibling) {
      await f.db.query("update goldens set provider_snapshot_id='offline-snapshot',config=$2::jsonb where id=$1", [
        f.row.goldenId,
        JSON.stringify({
          repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }],
          init: [],
        }),
      ]);
      await f.db.query(
        "insert into github_connections(user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at) values($1,123,'owner','Owner',$2,$3,now()+interval '1 hour')",
        [
          f.people.owner,
          await encryptSecret("offline-refresh", ENCRYPTION_KEY),
          await encryptSecret(access, ENCRYPTION_KEY),
        ],
      );
    }
    let githubRequests = 0;
    const { now, githubFetch } = options;
    const service = createRuntimeGitHub({
      sql: f.sql,
      key: ENCRYPTION_KEY,
      origin: "https://armada.test",
      commands: f.bridge,
      github: {
        store: createSqlVaultStore(f.sql),
        encryptionKey: ENCRYPTION_KEY,
        app: { clientId: "app", clientSecret: "offline-app-secret" },
        ...(now ? { now: () => new Date(now()) } : {}),
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          githubRequests++;
          if (githubFetch) return githubFetch(url, init);
          if (String(url).includes("/repos/")) return Response.json({ full_name: "example/web" });
          return Response.json({ id: 123, login: "owner", name: "Owner" });
        }) as unknown as typeof fetch,
      },
    });
    let broker = new GitHubBroker(
      (values) => f.journal.registerSecrets(values),
      (async (url: Parameters<typeof fetch>[0], options?: RequestInit) =>
        (await service.route(
          url instanceof Request ? new Request(url, options) : new Request(url.toString(), options),
        )) ?? new Response(null, { status: 404 })) as unknown as typeof fetch,
      options.now,
    );
    let configured: GitHubRuntimeConfiguration | undefined;
    f.github(async (value) => {
      broker.configure(value);
      configured = value ?? undefined;
    });
    return {
      close: () => f.close(),
      requests: () => githubRequests,
      f,
      service,
      access,
      get broker() {
        return broker;
      },
      config: () => {
        if (!configured) throw Error("Missing private configuration");
        return configured;
      },
      reset() {
        broker = new GitHubBroker(
          (values) => f.journal.registerSecrets(values),
          (async (url: Parameters<typeof fetch>[0], options?: RequestInit) =>
            (await service.route(
              url instanceof Request ? new Request(url, options) : new Request(url.toString(), options),
            )) ?? new Response(null, { status: 404 })) as unknown as typeof fetch,
          options.now,
        );
      },
    };
  });
}

test.each([
  ["capability issuance", 0, 0],
  ["command admission", 1, 0],
  ["acknowledgement publication", 1, 1],
] as const)("queued GitHub preparation rolls back %s on claim loss", async (phase, capabilities, commands) => {
  const { f, service, close } = await fixture();
  const state = async (tx: Sql) =>
    (
      await tx.query<{ capabilities: number; issued: number; commands: number; delivered: number }>(
        `select
        (select count(*)::int from runtime_github_capabilities where sandbox_id=$1) as capabilities,
        (select count(*)::int from github_runtime_issued where sandbox_id=$1) as issued,
        (select count(*)::int from runtime_commands where sandbox_id=$1 and starts_with(request_id, 'github_')) as commands,
        (select count(*)::int from runtime_github_capabilities where sandbox_id=$1 and delivered_at is not null) as delivered`,
        [f.row.id],
      )
    ).rows[0]!;
  let expired = false;
  try {
    await expect(
      service.prepareLaunch(f.caller, f.row.id, async (tx: Sql) => {
        const current = await state(tx);
        if (
          (phase === "capability issuance" && current.issued > 0) ||
          (phase === "command admission" && current.commands > 0) ||
          (phase === "acknowledgement publication" && current.delivered > 0)
        ) {
          expired = true;
          throw Error("Turn claim expired");
        }
      }),
    ).rejects.toThrow();
    expect(expired).toBe(true);
    expect(await state(f.sql)).toEqual({ capabilities, issued: capabilities, commands, delivered: 0 });

    await service.prepareLaunch(f.caller, f.row.id, async () => {});
    expect((await service.status(f.caller, f.row.id)).configured).toBe(true);
  } finally {
    await close();
  }
});

test.each([
  { scenario: "later grant", grantSeconds: 180, expectedSeconds: 40 },
  { scenario: "earlier grant", grantSeconds: 20, expectedSeconds: 20 },
  { scenario: "missing grant", grantSeconds: undefined, expectedSeconds: 40 },
])("Boat runtime GitHub configuration uses the correct expiry for $scenario", async (testCase) => {
  const now = Date.now();
  const { f, service, config } = await fixture("boat", {
    ...(testCase.grantSeconds === undefined ? {} : { commandGrantExpiresAt: now + testCase.grantSeconds * 1000 }),
  });
  try {
    await f.db.query("update sandboxes set expires_at=$2 where id=$1", [f.row.id, new Date(now + 40_000)]);
    await service.prepare(f.caller, f.row.id);
    expect(config().expiresAt).toBe(now + testCase.expectedSeconds * 1000);
  } finally {
    await f.close();
  }
});

test("an expired GitHub capability is refused and logged against its sandbox", async () => {
  const x = await fixture();
  const { f, service } = x;
  const warn = spyOn(console, "warn");
  try {
    await service.prepare(f.caller, f.row.id);
    await f.db.query("update runtime_github_capabilities set expires_at=now() where sandbox_id=$1", [f.row.id]);
    const requests = x.requests();
    const requestId = crypto.randomUUID();
    await expect(continueRequest(requestId, () => x.broker.acquire("example/web", "git"))).rejects.toThrow(
      "github_credentials_http_denied",
    );
    expect(x.requests()).toBe(requests);
    expect(warn.mock.calls.map(([value]) => JSON.parse(value))).toEqual([
      {
        level: "warn",
        message: "runtime_github_credentials_denied",
        event: "runtime_github_credentials_denied",
        requestId,
        sandboxId: f.row.id,
        reason: "capability_expired",
      },
    ]);
  } finally {
    warn.mockRestore();
    await x.close();
  }
});

test("Modal runtime GitHub credentials still work beyond the original deadline after extension", async () => {
  let clock = Date.now();
  const ceiling = new Date(clock + 20 * 60_000);
  const x = await fixture("modal", { now: () => clock, commandGrantExpiresAt: ceiling.getTime(), idle: true }),
    { f, service } = x;
  try {
    const { initial } = (
      await f.db.query<{ initial: Date }>("select expires_at as initial from sandboxes where id=$1", [f.row.id])
    ).rows[0]!;
    await service.prepare(f.caller, f.row.id);
    await f.db.query("update sandboxes set expires_at=$2 where id=$1", [f.row.id, ceiling]);
    clock = initial.getTime() + 1;
    expect((await x.broker.acquire("example/web", "git")) === x.access).toBe(true);
    await f.db.query("update sandboxes set expires_at=now()-interval '1 second' where id=$1", [f.row.id]);
    await expect(x.broker.acquire("example/web", "git")).rejects.toThrow();
  } finally {
    await f.close();
  }
});

// Shared reissue runs on Modal; runtime-checkpoint.test.ts owns the broader Boat checkpoint matrix.
test.each(["modal"] as const)(
  "checkpoint revokes acquisition immediately and a fresh epoch requires a new GitHub configuration (%s)",
  async (provider) => {
    const x = await fixture(provider),
      { f, service } = x;
    try {
      await service.prepare(f.caller, f.row.id);
      const old = x.config().capability;
      await x.broker.acquire("example/web", "git");
      const cp = await createRuntimeCheckpoint(
        f.sql,
        ENCRYPTION_KEY,
        f.bridge,
      )(f.caller, { id: f.row.id, request_id: crypto.randomUUID(), runtimeVersion: 1 });
      expect(cp).toMatchObject({
        runtime: { kind: "armada", epoch: f.active.epoch },
        checkpoint: { state: "complete" },
      });
      expect(cp.checkpoint.watermark).toBe(cp.checkpoint.acknowledgedSequence);
      expect(cp.checkpoint.watermark).toBeGreaterThan(0);
      await expect(x.broker.acquire("example/web", "git")).rejects.toThrow();
      await expect(service.prepare(f.caller, f.row.id)).rejects.toThrow();
      await f.db.query("update sandboxes set status='starting' where id=$1", [f.row.id]);
      x.reset();
      await f.reboot({ epoch: "1", watermark: cp.checkpoint.watermark, conversationId: f.first.conversationId });
      await f.db.query("update sandboxes set status='running' where id=$1", [f.row.id]);
      expect((await service.status(f.caller, f.row.id)).configured).toBe(false);
      await service.prepare(f.caller, f.row.id);
      expect(x.config().generation).toBe("2");
      expect(x.config().capability === old).toBe(false);
      expect((await x.broker.acquire("example/web", "gh")) === x.access).toBe(true);
    } finally {
      await f.close();
    }
  },
);

test("GitHub preflight returns the verified repository and connection identity", async () => {
  const { f, service } = await fixture("modal");
  try {
    const golden = (await f.db.query<{ name: string }>("select name from goldens where id=$1", [f.row.goldenId]))
      .rows[0]!;
    const result = await dispatchControlCommand(
      "sandbox/github-preflight-v1",
      f.caller,
      { org: f.people.org, golden: golden.name, repository: "example/web", runtimeVersion: 1 },
      { runtimeGitHub: service } as ControlOptions,
    );
    expect(sandboxCheckOperations.postSandboxGithubPreflightV1.output.parse(result)).toEqual({
      githubReady: true,
      provider: "modal",
      repository: "example/web",
      login: "owner",
    });
  } finally {
    await f.close();
  }
});

test("GitHub preflight rejects a cross-provider ambiguous golden name before requesting GitHub credentials", async () => {
  const x = await fixture("modal"),
    { f, service } = x;
  try {
    const golden = (await f.db.query<{ name: string }>("select name from goldens where id=$1", [f.row.goldenId]))
      .rows[0]!;
    await f.db.query(
      `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,config)
      values($1,$2,$3,'org','boat','other-master','other-image',$4::jsonb)`,
      [
        f.people.org,
        f.people.owner,
        golden.name,
        JSON.stringify({
          repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }],
          init: [],
        }),
      ],
    );
    await expect(
      service.preflight(f.caller, { org: f.people.org, golden: golden.name, repository: "example/web" }),
    ).rejects.toThrow();
    expect(x.requests()).toBe(0);
  } finally {
    await f.close();
  }
});

function runtimeCase(
  name: string,
  action: (x: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  provider: "boat" | "modal" = "boat",
) {
  describe("launch GitHub fixture", () => {
    const prepared = scopedRuntimeFixture(() => fixture(provider), { timeout: 20_000 });
    test(name, async () => action(await prepared()));
  });
}
describe("Boat GitHub access token rollover during launch", () => {
  let clock = 0;
  let githubRotated = false;
  const renewedAccess = "renewed-offline-access";
  const githubFetch = (async (url: string | URL | Request) => {
    if (String(url) === "https://github.com/login/oauth/access_token") {
      githubRotated = true;
      return Response.json({ access_token: renewedAccess, refresh_token: "renewed-offline-refresh", expires_in: 3600 });
    }
    return Response.json({ id: 123, login: "owner", name: "Owner" });
  }) as typeof fetch;
  const prepared = scopedRuntimeFixture(
    () => {
      clock = Date.now();
      githubRotated = false;
      return fixture("boat", { now: () => clock, githubFetch });
    },
    { timeout: 20_000 },
  );
  test("correlates token rotation across two same-owner launches during a multi-repository refresh", async () => {
    const x = await prepared();
    const { f, service } = x;
    const repositories = Array.from({ length: 8 }, (_, index) => `repo-${index + 1}`);
    await f.db.query("update goldens set config=$2::jsonb where id=$1", [
      f.row.goldenId,
      JSON.stringify({
        repos: repositories.map((dir) => ({ url: `https://github.com/example/${dir}.git`, branch: "main", dir })),
        init: [],
      }),
    ]);
    await f.db.query(
      "update sandboxes set status='starting',activity_lease_id=$2,activity_until=now()+interval '1 minute' where id=$1",
      [f.row.id, crypto.randomUUID()],
    );
    await f.db.query("update github_connections set access_expires_at=$2 where user_id=$1", [
      f.people.owner,
      new Date(clock + 5 * 60_000 + 37_000),
    ]);

    expect(await service.prepareLaunch(f.caller, f.row.id)).toMatchObject({ status: "connected" });
    expect(x.config().repositories).toEqual(repositories.map((repo) => `example/${repo}`));
    const sibling = await fixture("boat", {
      now: () => clock,
      githubFetch,
      sibling: { db: f.db, people: f.people, access: x.access, goldenId: f.row.goldenId },
    });
    const info = spyOn(console, "info");
    const log = spyOn(console, "warn");
    try {
      await f.db.query(
        "update sandboxes set status='starting',activity_lease_id=$2,activity_until=now()+interval '1 minute' where id=$1",
        [sibling.f.row.id, crypto.randomUUID()],
      );
      for (const repo of repositories.slice(0, -2)) {
        expect((await x.broker.acquire(`example/${repo}`, "git")) === x.access).toBe(true);
      }

      const requestId = crypto.randomUUID();
      const inFlightToken = await continueRequest(requestId, () => x.broker.acquire("example/repo-7", "git"));
      const gitStatus = (token: string) => (token === (githubRotated ? renewedAccess : x.access) ? 200 : 401);
      expect(gitStatus(inFlightToken)).toBe(200);
      clock += 37_000;
      expect(await sibling.service.prepareLaunch(sibling.f.caller, sibling.f.row.id)).toMatchObject({
        status: "connected",
      });
      expect(gitStatus(inFlightToken)).toBe(401);
      expect((await sibling.broker.acquire("example/repo-1", "git")) === renewedAccess).toBe(true);
      expect((await x.broker.acquire("example/repo-8", "git")) === renewedAccess).toBe(true);

      const events = info.mock.calls
        .map(([value]) => JSON.parse(value))
        .filter(({ event }) => event === "runtime_github_credentials_issued");
      expect(events).toHaveLength(9);
      const [before, rotated, after] = events.slice(-3);
      expect(before).toMatchObject({
        requestId,
        sandboxId: f.row.id,
        tokenFingerprint: expect.stringMatching(/^[a-f0-9]{32}$/),
      });
      expect(rotated).toMatchObject({
        sandboxId: sibling.f.row.id,
        tokenFingerprint: expect.stringMatching(/^[a-f0-9]{32}$/),
      });
      expect(rotated.tokenFingerprint).not.toBe(before.tokenFingerprint);
      expect(after).toMatchObject({ sandboxId: f.row.id, tokenFingerprint: rotated.tokenFingerprint });
      expect(JSON.stringify(events).includes(x.access)).toBe(false);
      expect(JSON.stringify(events).includes(renewedAccess)).toBe(false);

      await expect(x.broker.acquire("example/outside-golden", "git")).rejects.toThrow("github_credentials_http_denied");
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          level: "warn",
          message: "runtime_github_credentials_denied",
          event: "runtime_github_credentials_denied",
          sandboxId: f.row.id,
          reason: "repository_outside_binding",
        }),
      );
    } finally {
      info.mockRestore();
      log.mockRestore();
      await sibling.close();
    }
  });
});

for (const provider of ["boat", "modal"] as const)
  runtimeCase(
    `${provider} launch GitHub authority works only in an actively leased starting sandbox before private repository setup`,
    async (x) => {
      const { f, service } = x;
      await f.db.query(
        "update sandboxes set status='starting',activity_lease_id=null,activity_until=null where id=$1",
        [f.row.id],
      );
      await expect(service.prepareLaunch(f.caller, f.row.id)).rejects.toThrow();
      await f.db.query(
        "update sandboxes set activity_lease_id=$2,activity_until=now()+interval '1 minute' where id=$1",
        [f.row.id, crypto.randomUUID()],
      );
      expect(await service.prepareLaunch(f.caller, f.row.id)).toMatchObject({ status: "connected", login: "owner" });
      expect(await x.broker.acquire("example/web", "git")).toBe(x.access);
      await f.db.query("update sandboxes set activity_until=now()-interval '1 second' where id=$1", [f.row.id]);
      await expect(x.broker.acquire("example/web", "git")).rejects.toThrow();
    },
    provider,
  );

test.each(["modal", "boat"] as const)(
  "%s runtime renews expired GitHub credentials across a long turn and stop-resume while keeping launch repositories",
  async (provider) => {
    let clock = Date.now() - 10 * 3_600_000;
    let rotations = 0;
    let activeToken = "";
    const githubFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "https://github.com/login/oauth/access_token") {
        rotations++;
        activeToken = `ghu_renewed_${rotations}_${"a".repeat(24)}`;
        return Response.json({
          access_token: activeToken,
          refresh_token: `ghr_renewed_${rotations}_${"b".repeat(24)}`,
          expires_in: 3600,
        });
      }
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== `Bearer ${activeToken}`) return Response.json({ message: "Bad credentials" }, { status: 401 });
      return Response.json({ id: 123, login: "owner", name: "Owner" });
    }) as typeof fetch;
    const x = await fixture(provider, { now: () => clock, githubFetch });
    const { f, service } = x;
    activeToken = x.access;
    try {
      const launchWorkspace = {
        repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }],
        init: [],
      };
      await createJobsStore(f.sql, ENCRYPTION_KEY).enqueue(
        "launch_initial_turn",
        f.row.id,
        1,
        f.row.id,
        { launchJobId: crypto.randomUUID(), workspace: launchWorkspace, skills: [] },
        { orgId: f.people.org, maxAttempts: 3 },
      );
      await f.db.query("update github_connections set access_expires_at=$2 where user_id=$1", [
        f.people.owner,
        new Date(clock + 90 * 60_000),
      ]);

      expect(await service.prepareLaunch(f.caller, f.row.id)).toMatchObject({ status: "connected", login: "owner" });
      expect(x.config().repositories).toEqual(["example/web"]);
      expect(await x.broker.acquire("example/web", "git")).toBe(x.access);

      await f.db.query("update goldens set config=$2::jsonb where id=$1", [
        f.row.goldenId,
        JSON.stringify({
          repos: [{ url: "https://github.com/example/replacement.git", branch: "main", dir: "replacement" }],
          init: [],
        }),
      ]);

      clock += 2 * 3_600_000;
      const longTurnToken = await x.broker.acquire("example/web", "git");
      expect(longTurnToken).toBe(activeToken);
      expect(longTurnToken).not.toBe(x.access);
      expect(await x.broker.acquire("example/web", "gh")).toBe(longTurnToken);
      expect(rotations).toBe(1);
      await expect(x.broker.acquire("example/replacement", "git")).rejects.toThrow("github_credentials_http_denied");

      const cp = await createRuntimeCheckpoint(
        f.sql,
        ENCRYPTION_KEY,
        f.bridge,
      )(f.caller, { id: f.row.id, request_id: crypto.randomUUID(), runtimeVersion: 1 });
      await f.db.query("update sandboxes set status='starting',lifecycle_generation=3 where id=$1", [f.row.id]);
      x.reset();
      await f.reboot({ epoch: "1", watermark: cp.checkpoint.watermark, conversationId: f.first.conversationId });
      await f.db.query("update sandboxes set status='ready' where id=$1", [f.row.id]);

      clock += 2 * 3_600_000;
      expect(await service.prepareLaunch(f.caller, f.row.id)).toMatchObject({ status: "connected", login: "owner" });
      expect(x.config().generation).toBe("2");
      expect(x.config().repositories).toEqual(["example/web"]);
      const resumedToken = await x.broker.acquire("example/web", "git");
      expect(resumedToken).toBe(activeToken);
      expect(resumedToken).not.toBe(longTurnToken);
      expect(await x.broker.acquire("example/web", "gh")).toBe(resumedToken);
      expect(rotations).toBe(2);
      await expect(x.broker.acquire("example/replacement", "git")).rejects.toThrow("github_credentials_http_denied");
    } finally {
      await x.close();
    }
  },
);

test("Docker resume GitHub preparation skips plain images, rejects tampered manifests, and renews expired repo bindings", async () => {
  const f = await sharedDatabase();
  const sql: Sql = {
    query: (q, v) => f.db.query(q, v),
    transaction: (work) => f.db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const hostId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  await f.db.query(
    `insert into docker_hosts(id,org_id,owner_id,registration_expires_at,installation_id,hash)
     values($1,$2,$3,now()-interval '1 day',$4,$5)`,
    [hostId, f.people.org, f.people.owner, installationId, "d".repeat(64)],
  );
  const initialAccess = `ghu_docker_init_${"a".repeat(20)}`;
  let activeToken = initialAccess;
  let rotations = 0;
  let clock = Date.now() - 4 * 3_600_000;
  await f.db.query(
    "insert into github_connections(user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at) values($1,123,'owner','Owner',$2,$3,$4)",
    [
      f.people.owner,
      await encryptSecret("offline-refresh", ENCRYPTION_KEY),
      await encryptSecret(initialAccess, ENCRYPTION_KEY),
      new Date(clock + 30 * 60_000),
    ],
  );
  const caller = {
    userId: f.people.owner,
    orgs: [{ orgId: f.people.org, role: "member" as const }],
    via: "service" as const,
  };
  let configured: GitHubRuntimeConfiguration | undefined;
  let githubCalls = 0;
  const service = createRuntimeGitHub({
    sql,
    key: ENCRYPTION_KEY,
    origin: "https://armada.test",
    commands: {
      call: async (
        _owner: string,
        command: { op: string; requestId: string; configuration?: GitHubRuntimeConfiguration },
      ) => {
        if (command.op !== "configureGitHub" || !command.configuration) throw Error("Unexpected runtime command");
        configured = command.configuration;
        return {
          epoch: command.configuration.generation,
          requestId: command.requestId,
          status: 200,
          body: { version: 1, requestId: command.requestId, result: { acknowledged: true } },
        };
      },
    } as unknown as Parameters<typeof createRuntimeGitHub>[0]["commands"],
    github: {
      store: createSqlVaultStore(sql),
      encryptionKey: ENCRYPTION_KEY,
      app: { clientId: "app", clientSecret: "offline-app-secret" },
      now: () => new Date(clock),
      fetch: (async (url: string | URL | Request) => {
        githubCalls++;
        if (String(url) === "https://github.com/login/oauth/access_token") {
          rotations++;
          activeToken = `ghu_docker_renewed_${rotations}_${"c".repeat(16)}`;
          return Response.json({
            access_token: activeToken,
            refresh_token: `ghr_docker_renewed_${rotations}_${"d".repeat(16)}`,
            expires_in: 3600,
          });
        }
        return Response.json({ id: 123, login: "owner", name: "Owner" });
      }) as typeof fetch,
    },
  });

  const makeDockerSandbox = async (
    request: { image: string; repos?: { url: string; branch: string; dir: string }[] },
    options: {
      tamperHash?: boolean;
      skipManifest?: boolean;
      actorEpoch?: string;
      snapshotConfig?: { repos: { url: string; branch: string; dir: string }[]; init: string[] };
    } = {},
  ) => {
    const id = crypto.randomUUID();
    const dockerGeneration = crypto.randomUUID();
    await f.db.query(
      `insert into sandboxes(id,org_id,owner_id,provider,provider_sandbox_id,harness,status,model,reasoning_effort,
       lifecycle_generation,docker_host_id,docker_installation_id,docker_generation,docker_image,expires_at)
       values($1,$2,$3,'docker',$4,'codex','ready','gpt-5.4','high',3,$5,$6,$7,$8,now()+interval '1 hour')`,
      [
        id,
        f.people.org,
        f.people.owner,
        `armada-${installationId}-${hostId}-${id}-${dockerGeneration}`,
        hostId,
        installationId,
        dockerGeneration,
        request.image,
      ],
    );
    const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY, { allowDockerIssue: true });
    const issued = await authority.issue({ sandboxId: id, ownerId: f.people.owner, configuration: {} });
    await authority.enrol(issued.enrolmentToken);
    if (!options.skipManifest) {
      const requestHash = options.tamperHash ? "0".repeat(64) : dockerLaunchRequestHash(request);
      const { id: jobId } = await enqueueLaunch(
        createJobsStore(sql, ENCRYPTION_KEY),
        id,
        1,
        `docker-test-${id}`,
        { request, ...(options.snapshotConfig ? { snapshotConfig: options.snapshotConfig } : {}) },
        {
          orgId: f.people.org,
          deadline: new Date(Date.now() + 60_000),
          maxAttempts: 1,
          request: { ownerId: f.people.owner, digest: requestHash },
        },
      );
      await recordDockerLaunchEvidence(sql, jobId, { docker_actor_epoch: options.actorEpoch ?? "1" });
    }
    return id;
  };

  const dockerImage = `ghcr.io/example/plain@sha256:${"a".repeat(64)}`;
  const plainId = await makeDockerSandbox({ image: dockerImage });
  expect(await service.prepareLaunch(caller, plainId)).toMatchObject({ status: "not_connected" });
  expect(githubCalls).toBe(0);
  await expect(service.prepare(caller, plainId)).rejects.toThrow();

  const tamperedId = await makeDockerSandbox({ image: dockerImage }, { tamperHash: true });
  await expect(service.prepareLaunch(caller, tamperedId)).rejects.toThrow();
  expect(githubCalls).toBe(0);

  const missingManifestId = await makeDockerSandbox({ image: dockerImage }, { skipManifest: true });
  const staleEpochId = await makeDockerSandbox({ image: dockerImage }, { actorEpoch: "99" });
  await expect(service.prepareLaunch(caller, missingManifestId)).rejects.toThrow();
  await expect(service.prepareLaunch(caller, staleEpochId)).rejects.toThrow();
  expect(githubCalls).toBe(0);

  const repoId = await makeDockerSandbox({
    image: dockerImage,
    repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }],
  });
  clock += 2 * 3_600_000;
  expect(await service.prepareLaunch(caller, repoId)).toMatchObject({ status: "connected", login: "owner" });
  expect(configured?.repositories).toEqual(["example/web"]);
  expect(rotations).toBe(1);
  const firstRenewed = activeToken;
  const broker = new GitHubBroker(
    () => {},
    (async (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      (await service.route(url instanceof Request ? new Request(url, init) : new Request(url.toString(), init))) ??
      new Response(null, { status: 404 })) as unknown as typeof fetch,
    () => clock,
  );
  broker.configure(configured!);
  expect(await broker.acquire("example/web", "git")).toBe(firstRenewed);
  clock += 2 * 3_600_000;
  const midTurnRenewed = await broker.acquire("example/web", "git");
  expect(midTurnRenewed).toBe(activeToken);
  expect(midTurnRenewed).not.toBe(firstRenewed);
  expect(await broker.acquire("example/web", "gh")).toBe(midTurnRenewed);
  expect(rotations).toBe(2);
  await expect(broker.acquire("example/other", "git")).rejects.toThrow("github_credentials_http_denied");

  const snapshotId = await makeDockerSandbox(
    { image: dockerImage },
    {
      snapshotConfig: {
        repos: [{ url: "https://github.com/example/snapshot.git", branch: "main", dir: "snapshot" }],
        init: [],
      },
    },
  );
  expect(await service.prepareLaunch(caller, snapshotId)).toMatchObject({ status: "connected", login: "owner" });
  expect(configured?.repositories).toEqual(["example/snapshot"]);
  broker.configure(configured!);
  expect(await broker.acquire("example/snapshot", "gh")).toBe(activeToken);
  await expect(broker.acquire("example/web", "gh")).rejects.toThrow("github_credentials_http_denied");

  await f.db.query("delete from github_connections where user_id=$1", [f.people.owner]);
  const callsBeforeDisconnect = githubCalls;
  await expect(service.prepareLaunch(caller, missingManifestId)).rejects.toThrow();
  await expect(service.prepareLaunch(caller, staleEpochId)).rejects.toThrow();
  expect(githubCalls).toBe(callsBeforeDisconnect);
});

test("Modal prepareLaunch skips docker_launch_manifests, canonicalizes JSONB in JS, and avoids duplicate owner/authority queries", async () => {
  const x = await fixture("modal");
  const { f } = x;
  try {
    const queries: string[] = [];
    let transactions = 0;
    const trackedSql: Sql = {
      async query(text, params) {
        queries.push(text);
        return f.sql.query(text, params);
      },
      async transaction(work) {
        transactions++;
        return f.sql.transaction!((tx) =>
          work({
            query(text, params) {
              queries.push(text);
              return tx.query(text, params);
            },
          }),
        );
      },
    };
    const launchWorkspace = {
      repos: [{ dir: "web", branch: "main", url: "https://github.com/example/web.git" }],
      init: [],
    };
    await createJobsStore(f.sql, ENCRYPTION_KEY).enqueue(
      "launch_initial_turn",
      f.row.id,
      1,
      f.row.id,
      { launchJobId: crypto.randomUUID(), workspace: launchWorkspace, skills: [] },
      { orgId: f.people.org, maxAttempts: 3 },
    );
    const service = createRuntimeGitHub({
      sql: trackedSql,
      key: ENCRYPTION_KEY,
      origin: "https://armada.test",
      commands: f.bridge,
      github: {
        store: createSqlVaultStore(trackedSql),
        encryptionKey: ENCRYPTION_KEY,
        app: { clientId: "app", clientSecret: "offline-app-secret" },
        fetch: (async () => Response.json({ id: 123, login: "owner", name: "Owner" })) as unknown as typeof fetch,
      },
    });
    expect(await service.prepareLaunch(f.caller, f.row.id)).toMatchObject({ status: "connected", login: "owner" });
    expect(queries.some((q) => q.includes("select $1::jsonb"))).toBe(false);
    expect(queries.some((q) => q.includes("docker_launch_manifests"))).toBe(false);
    expect(queries.filter((q) => q.includes("from public.sandboxes s join public.goldens g"))).toHaveLength(1);
    expect(queries.filter((q) => q.includes("as binding,s.expires_at"))).toHaveLength(2);
    expect(transactions).toBe(2);
    const broker = new GitHubBroker(
      () => {},
      (async (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        (await service.route(url instanceof Request ? new Request(url, init) : new Request(url.toString(), init))) ??
        new Response(null, { status: 404 })) as unknown as typeof fetch,
    );
    broker.configure(x.config());
    expect(await broker.acquire("example/web", "git")).toBe(x.access);
    expect(queries.some((q) => q.includes("select $1::jsonb"))).toBe(false);
    expect(queries.some((q) => q.includes("docker_launch_manifests"))).toBe(false);
  } finally {
    await x.close();
  }
});
