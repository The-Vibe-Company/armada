import { describe, expect, test } from "bun:test";
import { sandboxCheckOperations } from "@armada/core/contract";
import { createSqlVaultStore, encryptSecret, type GitHubRuntimeConfiguration, type Sql } from "@armada/core/server";
import { GitHubBroker } from "../../agent-runtime/src/github-broker.ts";
import { type ControlOptions, dispatchControlCommand } from "../src/control.ts";
import { createRuntimeCheckpoint } from "../src/runtime-checkpoint.ts";
import { createRuntimeGitHub } from "../src/runtime-github.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { configureRuntimeFixture, runtimeFixture, scopedRuntimeFixture } from "./runtime.fixture.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function fixture(
  provider: "boat" | "modal" = "boat",
  options: { now?: () => number; commandGrantExpiresAt?: number; idle?: boolean } = {},
) {
  const f = await runtimeFixture(
    await sharedDatabase(),
    provider,
    "codex",
    options.idle,
    options.commandGrantExpiresAt,
  );
  return configureRuntimeFixture(f, async () => {
    await f.db.query("update goldens set provider_snapshot_id='offline-snapshot',config=$2::jsonb where id=$1", [
      f.row.goldenId,
      JSON.stringify({ repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }], init: [] }),
    ]);
    await f.db.query("update sandboxes set expires_at=now()+interval '45 seconds' where id=$1", [f.row.id]);
    const access = `ghu_offline_${crypto.randomUUID().replaceAll("-", "")}`;
    await f.db.query(
      "insert into github_connections(user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at) values($1,123,'owner','Owner',$2,$3,now()+interval '1 hour')",
      [
        f.people.owner,
        await encryptSecret("offline-refresh", ENCRYPTION_KEY),
        await encryptSecret(access, ENCRYPTION_KEY),
      ],
    );
    let githubRequests = 0;
    const service = createRuntimeGitHub({
      sql: f.sql,
      key: ENCRYPTION_KEY,
      origin: "https://armada.test",
      commands: f.bridge,
      github: {
        store: createSqlVaultStore(f.sql),
        encryptionKey: ENCRYPTION_KEY,
        app: { clientId: "app", clientSecret: "offline-app-secret" },
        fetch: (async (url: string | URL | Request) => {
          githubRequests++;
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

test("Boat runtime GitHub configuration expires at the committed sandbox deadline", async () => {
  const { f, service, config } = await fixture("boat", { commandGrantExpiresAt: Date.now() + 20 * 60_000 });
  try {
    await service.prepare(f.caller, f.row.id);
    const { expires_at } = (
      await f.db.query<{ expires_at: Date }>("select expires_at from sandboxes where id=$1", [f.row.id])
    ).rows[0]!;
    expect(config().expiresAt).toBe(expires_at.getTime());
  } finally {
    await f.close();
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
