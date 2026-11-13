import { expect, test } from "bun:test";
import { createSqlVaultStore, encryptSecret, type GitHubRuntimeConfiguration } from "@armada/core/server";
import { GitHubBroker } from "../../agent-runtime/src/github-broker.ts";
import { createRuntimeCheckpoint } from "../src/runtime-checkpoint.ts";
import { createRuntimeGitHub } from "../src/runtime-github.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { ENCRYPTION_KEY } from "./support.ts";

async function fixture() {
  const f = await runtimeFixture();
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
  let userHook: (() => Promise<void>) | undefined;
  const service = createRuntimeGitHub({
    sql: f.sql,
    key: ENCRYPTION_KEY,
    origin: "https://armada.test",
    commands: f.bridge,
    github: {
      store: createSqlVaultStore(f.sql),
      encryptionKey: ENCRYPTION_KEY,
      app: { clientId: "app", clientSecret: "offline-app-secret" },
      fetch: (async () => {
        await userHook?.();
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
  );
  let configured: GitHubRuntimeConfiguration | undefined;
  f.github(async (value) => {
    broker.configure(value);
    configured = value ?? undefined;
  });
  return {
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
    hook(fn: () => Promise<void>) {
      userHook = fn;
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
}

test("runtime GitHub uses durable private RPC, owner identity and epoch/repository broker fencing without host/native hooks", async () => {
  const x = await fixture(),
    { f, service } = x;
  try {
    const result = await callSharedTool({ ...f.context, runtimeGitHub: service }, "github_refresh", { id: f.row.id });
    expect(result).toMatchObject({ status: "connected", runtime: { kind: "armada", epoch: "1" } });
    expect(JSON.stringify(result)).not.toMatch(/armada_gh_|ghu_/);
    expect(x.config()).toMatchObject({
      generation: "1",
      identity: { name: "Owner", email: "123+owner@users.noreply.github.com" },
    });
    expect((await service.status(f.caller, f.row.id)).credentialRequests).toBe(0);
    const token = await x.broker.acquire("example/web", "gh");
    expect(token === x.access).toBe(true);
    expect(f.journal.redact(token).includes(token)).toBe(false);
    const status = await service.status(f.caller, f.row.id);
    expect(status).toMatchObject({ configured: true, credentialRequests: 1 });
    await expect(x.broker.acquire("foreign/repo", "gh")).rejects.toThrow();
    await expect(service.prepare({ ...f.caller, userId: f.people.admin }, f.row.id)).rejects.toThrow();
    expect((await service.status(f.caller, f.row.id)).credentialRequests).toBe(1);
    const capability = x.config().capability;
    x.hook(async () => {
      await f.authority.enrol(
        (await f.authority.issue({ sandboxId: f.row.id, ownerId: f.people.owner, configuration: {} })).enrolmentToken,
      );
    });
    await expect(x.broker.acquire("example/web", "gh")).rejects.toThrow();
    const old = await service.route(
      new Request("https://armada.test/api/runtime/github/credentials", {
        method: "POST",
        headers: { authorization: `Bearer ${capability}` },
        body: JSON.stringify({ version: 1, repository: "example/web", operation: "git" }),
      }),
    );
    expect(old?.status).toBe(403);
    expect((await service.status(f.caller, f.row.id)).configured).toBe(false);
  } finally {
    await f.close();
  }
});

test("checkpoint revokes acquisition immediately and a fresh epoch requires a new GitHub configuration", async () => {
  const x = await fixture(),
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
});
