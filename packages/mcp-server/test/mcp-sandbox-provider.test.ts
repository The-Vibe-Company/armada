import { expect, spyOn, test } from "bun:test";
import { createSqlMcpRegistry, createSqlSandboxStore, createSqlVaultStore, encryptSecret } from "@armada/core/server";
import { createSqlModalStore, type Machine, type Scope, scopeKey } from "@armada/provider-modal";
import { type App, AppService, type Sandbox, SandboxService } from "modal";
import { providerRegistry } from "../src/http.ts";
import { createMcpLifecycle } from "../src/mcp-lifecycle.ts";
import { createMcpSandboxProviderResolver } from "../src/mcp-sandbox-provider.ts";
import { createModalIntegration } from "../src/modal-integration.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

// Real SQL -> production renewal resolver -> registry -> composed Modal adapter -> SQL machine
// scope -> physical SDK poll -> lease UPDATE. The SDK alone is replaced; no cloud authority.
test("MCP renewal finds a private Modal machine forked from an org golden with its pinned org credentials", async () => {
  const { db, people } = await database();
  const binding = { workspace: "app:ap-renew", environment: "main", appId: "ap-renew" };
  const apps = spyOn(AppService.prototype, "fromName").mockImplementation(async (name, options) => {
    expect(name).toBe("renew-org-app");
    expect(options).toEqual({ environment: "main", createIfMissing: false });
    return { appId: binding.appId } as App;
  });
  let polls = 0;
  const physicals = spyOn(SandboxService.prototype, "fromId").mockImplementation(async (id) => {
    expect(id).toBe("sb-renew-physical");
    return {
      poll: async () => {
        polls++;
        return null;
      },
    } as unknown as Sandbox;
  });
  try {
    await db.query(
      "insert into modal_server_apps(org_id,authority,authority_scope,authority_owner_id,app_name,app_id,environment) values($1,$2,'org',$1,'renew-org-app',$3,'main')",
      [people.org, `org:${people.org}`, binding.appId],
    );
    await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('org',$1,'modal',$2)", [
      people.org,
      await encryptSecret(
        JSON.stringify({ token_id: "ak-reneworganization", token_secret: "as-reneworganization" }),
        ENCRYPTION_KEY,
      ),
    ]);
    // Invalid personal credentials must never override the org source's pinned credential slot.
    await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'modal',$2)", [
      people.owner,
      await encryptSecret("invalid-personal-pair", ENCRYPTION_KEY),
    ]);
    const golden = crypto.randomUUID(),
      sandbox = crypto.randomUUID();
    await db.query(
      "insert into goldens(id,org_id,owner_id,name,visibility,provider,modal_workspace,modal_environment,modal_app_id) values($1,$2,$3,'renew-source','org','modal',$4,'main',$5)",
      [golden, people.org, people.admin, binding.workspace, binding.appId],
    );
    await createSqlSandboxStore(db).insert({
      id: sandbox,
      provider: "modal",
      providerSandboxId: "bx-renew",
      goldenId: golden,
      orgId: people.org,
      ownerId: people.owner,
      visibility: "private",
      harness: "codex",
      status: "ready",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
    });
    const scope: Scope = { orgId: people.org, userId: people.owner, visibility: "private", binding };
    const expiry = new Date(Date.now() + 6 * 3600000);
    const machine: Machine = {
      info: {
        id: "bx-renew",
        name: "private fork",
        state: "ready",
        providerState: "active",
        labels: {},
        expiresAt: expiry,
      },
      phase: "active",
      generation: 1,
      golden: false,
      ttlSeconds: 21600,
      physicalId: "sb-renew-physical",
      physicalName: "private-fork",
      launchUserId: people.owner,
      managementAuthority: { credentialScope: "org", credentialOwnerId: people.org },
      sourceImage: { scopeKey: scopeKey({ ...scope, visibility: "org" }), name: "source", imageId: "im-source" },
    };
    await createSqlModalStore(db, scope).reserve("private-fork", machine);
    const connection = crypto.randomUUID(),
      grant = crypto.randomUUID(),
      lease = crypto.randomUUID();
    await db.query(
      "insert into mcp_connections(id,org_id,owner_id,scope,name,transport,url,auth_type) values($1,$2,$3,'personal','renew','http','https://mcp.example','none')",
      [connection, people.org, people.owner],
    );
    await db.query("insert into mcp_grants(id,connection_id,status) values($1,$2,'connected')", [grant, connection]);
    await db.query("insert into mcp_bindings(sandbox_id,connection_id,grant_id) values($1,$2,$3)", [
      sandbox,
      connection,
      grant,
    ]);
    await db.query(
      "insert into mcp_bootstraps(sandbox_id,physical_generation,revision,configured) values($1,$2,'installed',true)",
      [sandbox, JSON.stringify(["modal", "bx-renew", "1"])],
    );
    const before = new Date(Date.now() + 60000);
    await db.query(
      "insert into mcp_leases(id,sandbox_id,connection_id,grant_id,org_id,owner_id,generation,sandbox_generation,hash,operations,expires_at) values($1,$2,$3,$4,$5,$6,1,1,$7,array['tools'],$8)",
      [lease, sandbox, connection, grant, people.org, people.owner, "a".repeat(64), before],
    );
    const vault = createSqlVaultStore(db);
    const modal = await createModalIntegration({
      sql: db,
      vault,
      encryptionKey: ENCRYPTION_KEY,
      publicUrl: "https://armada.test",
    });
    const registry = providerRegistry({
      vault,
      encryptionKey: ENCRYPTION_KEY,
      providerFor: () => {
        throw Error("Unexpected Boat fallback");
      },
      modalTokensFor: modal.modalTokensFor,
      modalProviderFor: modal.modalProviderFor,
    });
    const resolve = createMcpSandboxProviderResolver(db, registry);
    const lifecycle = createMcpLifecycle({
      sql: db,
      encryptionKey: ENCRYPTION_KEY,
      origin: "https://armada.test",
      registry: createSqlMcpRegistry(db, ENCRYPTION_KEY),
    });
    await lifecycle.renewLeases(await resolve(sandbox), sandbox);
    const renewed = (await db.query<{ expires_at: Date }>("select expires_at from mcp_leases where id=$1", [lease]))
      .rows[0];
    expect(new Date(renewed?.expires_at ?? 0).getTime()).toBe(expiry.getTime());
    expect(polls).toBe(1);
    await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.owner]);
    await expect(resolve(sandbox)).rejects.toThrow("No authorized active sandbox");
    expect(
      new Date(
        (await db.query<{ expires_at: Date }>("select expires_at from mcp_leases where id=$1", [lease])).rows[0]
          ?.expires_at ?? 0,
      ).getTime(),
    ).toBe(expiry.getTime());
    expect(polls).toBe(1);
  } finally {
    apps.mockRestore();
    physicals.mockRestore();
    await db.close();
  }
});
