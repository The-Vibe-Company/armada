import { expect, test } from "bun:test";
import { createSqlAuthStore } from "@armada/auth";
import {
  createSqlMcpGrantPort,
  createSqlMcpLaunchPort,
  createSqlMcpLeasePort,
  createSqlMcpRegistry,
  type Sql,
} from "@armada/core";
import { createSqlData } from "../src/data.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

test("registry separates personal grants, fences leases on revoke, and refuses shared impersonation", async () => {
  const { db, people: p } = await database();
  try {
    const registry = createSqlMcpRegistry(db, ENCRYPTION_KEY);
    const input = {
      name: "Public tools",
      scope: "personal" as const,
      transport: "http" as const,
      url: "https://mcp.example.com/mcp",
    };
    const c = await registry.save(p.owner, p.org, input);
    expect(c.status).toBe("not_connected");
    const grants = createSqlMcpGrantPort(db);
    expect(c.authType).toBe("auto");
    const handshake = await grants.begin(c.id);
    if (!handshake) throw new Error("Missing grant");
    expect(await grants.discovered(c.id, handshake.generation, "none")).toBe(true);
    expect((await registry.get(p.owner, p.org, c.id)).authType).toBe("none");
    expect(await registry.list(p.member, p.org)).toEqual([]);
    expect(await registry.list(p.admin, p.org)).toEqual([]);
    await expect(registry.get(p.owner, p.otherOrg, c.id)).rejects.toThrow();
    await expect(registry.save(p.member, p.org, { ...input, scope: "org" })).rejects.toThrow();
    const shared = await registry.save(p.admin, p.org, { ...input, scope: "org" });
    expect((await registry.get(p.member, p.org, shared.id)).id).toBe(shared.id);
    // This caller belongs to both orgs: denial is selected-org isolation, not missing membership.
    await expect(registry.get(p.member, p.otherOrg, shared.id)).rejects.toThrow(/No such/);
    await expect(registry.revoke(p.member, p.org, shared.id)).rejects.toThrow(/administrator/);
    const sharedProbe = await grants.begin(shared.id);
    if (!sharedProbe) throw new Error("Missing shared grant");
    expect(await grants.discovered(shared.id, sharedProbe.generation, "oauth")).toBe(true);
    expect(await registry.get(p.admin, p.org, shared.id)).toMatchObject({ authType: "oauth", status: "not_connected" });
    const launch = createSqlMcpLaunchPort(db, registry);
    await launch.validate({ userId: p.owner, orgId: p.org }, [c.id], "org");
    await launch.validate({ userId: p.owner, orgId: p.org }, [c.id], "private");
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0];
    if (!golden) throw new Error("Missing shared fixture");
    const sandbox = crypto.randomUUID();
    await db.query(
      "insert into sandboxes(id,boat_id,golden_id,org_id,owner_id,harness,status,visibility) values($1,'bx_registry',$2,$3,$4,'claude','ready','org')",
      [sandbox, golden.id, p.org, p.owner],
    );

    await launch.bind(sandbox, [c.id]);
    await db.query("update sandboxes set access_owner_id=$2 where id=$1", [sandbox, p.admin]);
    await expect(launch.validate({ userId: p.admin, orgId: p.org }, [c.id], "org")).rejects.toThrow();
    expect(await registry.sandboxConnections(p.admin, p.org, sandbox)).toEqual([]);
    await expect(registry.sandboxConnections(p.member, p.org, sandbox)).rejects.toThrow(/No such/);
    const wrongOwnerSandbox = crypto.randomUUID();
    await db.query(
      "insert into sandboxes(id,boat_id,golden_id,org_id,owner_id,harness,status,visibility) values($1,'bx_wrong_owner',$2,$3,$4,'claude','ready','org')",
      [wrongOwnerSandbox, golden.id, p.org, p.admin],
    );
    await expect(launch.bind(wrongOwnerSandbox, [c.id])).rejects.toThrow(/cannot be bound/);
    const leases = createSqlMcpLeasePort(db);
    const hash = "a".repeat(64);
    await leases.issue({
      sandboxId: sandbox,
      connectionId: c.id,
      tokenHash: hash,
      operations: ["tools"],
      expiresAt: new Date("2100-01-01"),
    });
    expect(await leases.validate(hash, "tools")).not.toBeNull();
    expect(await leases.validate(hash, "resources")).toBeNull();
    await registry.metadata(p.owner, p.org, c.id, { name: "Renamed live", defaultForLaunch: true });
    expect(await leases.validate(hash, "tools")).not.toBeNull();
    await registry.metadata(p.owner, p.org, c.id, { defaultForLaunch: false });
    expect((await registry.sandboxConnections(p.owner, p.org, sandbox)).map((c) => c.id)).toEqual([c.id]);
    await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [sandbox]);
    await db.query("update sandboxes set status='ready',stopped_at=null where id=$1", [sandbox]);
    expect(await leases.validate(hash, "tools")).toBeNull();
    const nextHash = "b".repeat(64);
    await leases.issue({
      sandboxId: sandbox,
      connectionId: c.id,
      tokenHash: nextHash,
      operations: ["tools"],
      expiresAt: new Date("2100-01-01"),
    });
    expect(await leases.validate(nextHash, "tools")).not.toBeNull();
    const refreshOwner = crypto.randomUUID();
    const acquired = await grants.acquire(c.id, refreshOwner);
    expect(acquired).not.toBeNull();
    expect(await grants.acquire(c.id, crypto.randomUUID())).toBeNull();
    await db.query("update mcp_grants set refresh_until=now()-interval '1 second' where connection_id=$1", [c.id]);
    expect(await grants.acquire(c.id, crypto.randomUUID())).toBeNull();
    expect((await registry.get(p.owner, p.org, c.id)).status).toBe("needs_reconnect");
    // Before any revoke: uncertainty itself must fail closed at every authorization boundary.
    expect(await leases.validate(nextHash, "tools")).toBeNull();
    await expect(
      leases.issue({
        sandboxId: sandbox,
        connectionId: c.id,
        tokenHash: "7".repeat(64),
        operations: ["tools"],
        expiresAt: new Date("2100-01-01"),
      }),
    ).rejects.toThrow(/No active/);
    await expect(db.query("update mcp_bindings set grant_id=grant_id where sandbox_id=$1", [sandbox])).rejects.toThrow(
      /cannot be bound/,
    );
    await registry.revoke(p.owner, p.org, c.id);
    expect(await leases.validate(nextHash, "tools")).toBeNull();
    expect(await grants.discovered(c.id, handshake.generation, "none")).toBe(false);
    const grant = acquired as { id: string; version: number; generation: number };
    expect(await grants.rotate(grant.id, refreshOwner, grant.version, grant.generation, new Uint8Array([1]))).toBe(
      false,
    );
    const newGeneration = await grants.begin(c.id);
    expect(newGeneration?.value_enc).toBeNull();
    const newOwner = crypto.randomUUID();
    const newClaim = await grants.acquire(c.id, newOwner);
    if (!newClaim) throw new Error("Fresh connect did not clear abandoned refresh claim");
    expect(await grants.rotate(newClaim.id, refreshOwner, newClaim.version, newClaim.generation, null)).toBe(false);
    expect(await grants.rotate(newClaim.id, newOwner, newClaim.version + 1, newClaim.generation, null)).toBe(false);
    expect(await grants.rotate(newClaim.id, newOwner, newClaim.version, newClaim.generation - 1, null)).toBe(false);
    expect(await grants.rotate(newClaim.id, newOwner, newClaim.version, newClaim.generation, null)).toBe(true);
    expect(await grants.acquire(c.id, crypto.randomUUID())).not.toBeNull();
    // A user JWT sees definitions only, not ciphertext, bindings or scoped token hashes.
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [p.owner]);
    expect((await db.query("select id from mcp_connections")).rows).toHaveLength(2);
    for (const table of ["mcp_grants", "mcp_bindings", "mcp_leases"]) {
      await expect(db.query(`select * from ${table}`)).rejects.toThrow(/permission denied/);
    }
    await db.exec("reset role");
    await db.query("delete from members where user_id=$1 and org_id=$2", [p.owner, p.org]);
    await expect(registry.get(p.owner, p.org, c.id)).rejects.toThrow(/membership/);
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [p.owner]);
    expect((await db.query("select id from mcp_connections")).rows).toEqual([]);
    await db.exec("reset role");
  } finally {
    await db.close();
  }
});

test("control DTOs never echo authentication and report an unconfigured broker honestly", async () => {
  const { db, people: p } = await database();
  try {
    const { createSqlVaultStore, decryptSecret } = await import("@armada/core");
    const { handleControlRequest } = await import("../src/control.ts");
    const options = {
      authStore: createSqlAuthStore(db),
      supabase: {
        supabaseUrl: "https://project.supabase.co",
        anonKey: "public-anon",
        fetch: async () => Response.json({ id: p.owner }),
      },
      encryptionKey: ENCRYPTION_KEY,
      store: createSqlVaultStore(db),
      mcp: { registry: createSqlMcpRegistry(db, ENCRYPTION_KEY) },
    };
    const call = async (action: string, body: Record<string, unknown>) => {
      const response = await handleControlRequest(
        new Request(`https://armada.example.com/api/v1/mcp/${action}`, {
          method: "POST",
          headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig", "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        options,
      );
      if (!response) throw new Error("MCP control route was not mounted");
      return {
        status: response.status,
        body: (await response.json()) as {
          connection: import("@armada/core").McpConnectionDto;
          authorizationUrl?: string;
          connections?: unknown[];
          ok?: boolean;
        },
      };
    };
    expect((await call("metadata", { org: p.org, id: "not-a-uuid", name: "Invalid" })).status).toBe(400);
    const authentication = "write-only-test-bearer";
    const created = await call("create", {
      org: p.org,
      name: "Private tools",
      scope: "personal",
      transport: "http",
      url: "https://mcp.example.com",
      authType: "bearer",
      authentication,
    });
    expect(created.status).toBe(200);
    expect(JSON.stringify(created.body)).not.toContain(authentication);
    expect(created.body.connection.status).toBe("not_connected");
    const id = created.body.connection.id;
    const ciphertext = (
      await db.query<{ value_enc: Uint8Array<ArrayBuffer> }>(
        "select value_enc from mcp_grants where connection_id=$1",
        [id],
      )
    ).rows[0];
    if (!ciphertext) throw new Error("Grant was not persisted");
    expect(await decryptSecret(ciphertext.value_enc, ENCRYPTION_KEY)).toBe(authentication);
    const connected = await call("connect", { org: p.org, id });
    expect(connected.body.connection.status).toBe("unavailable");
    expect(connected.body.connection.lastError).toContain("not configured");
    expect(connected.body.authorizationUrl).toBeUndefined();
    expect((await call("status", { org: p.otherOrg, id })).status).toBe(403);
    expect((await call("delete", { org: p.org, id })).body.ok).toBe(true);
    expect((await call("list", { org: p.org })).body.connections).toEqual([]);
  } finally {
    await db.close();
  }
});

test("MCP resource queries survive unchanged, while credentials remain encrypted write-only payloads", async () => {
  const { db, people: p } = await database();
  try {
    const registry = createSqlMcpRegistry(db, ENCRYPTION_KEY);
    const definition = {
      name: "Project",
      scope: "personal" as const,
      transport: "http" as const,
      url: "https://mcp.supabase.com/mcp?project_ref=abc&read_only=true&feature=a%2Fb&feature=c+d",
    };
    const c = await registry.save(p.owner, p.org, definition);
    expect(c.url).toBe(definition.url);
    expect((await registry.list(p.owner, p.org))[0]?.url).toBe(definition.url);
    for (const suffix of [
      "#fragment",
      "#",
      "?access_token=hidden",
      "?TOKEN=hidden",
      "?api-key=hidden",
      "?password=hidden",
      "?client_secret=hidden",
      "?%61pi_key=hidden",
      "?x-api-key=hidden",
    ]) {
      await expect(
        registry.save(p.owner, p.org, { ...definition, url: `https://mcp.example.com/mcp${suffix}` }),
      ).rejects.toThrow();
    }
    await expect(
      registry.save(p.owner, p.org, { ...definition, url: "https://user:pass@mcp.example.com" }),
    ).rejects.toThrow();
    await expect(registry.save(p.owner, p.org, { ...definition, url: "https://@mcp.example.com" })).rejects.toThrow();
    const { decryptSecret } = await import("@armada/core");
    for (const [authType, authentication] of [
      ["bearer", "opaque-bearer-value"],
      ["headers", JSON.stringify({ "X-Api-Key": "opaque-header-value" })],
      ["oauth", JSON.stringify({ client_id: "preregistered-client", client_secret: "opaque-client-secret" })],
    ] as const) {
      const saved = await registry.save(p.owner, p.org, { ...definition, authType, authentication });
      expect(saved.status).toBe("not_connected");
      expect(JSON.stringify(saved)).not.toContain(authentication);
      const grant = (
        await db.query<{ value_enc: Uint8Array<ArrayBuffer> }>(
          "select value_enc from mcp_grants where connection_id=$1",
          [saved.id],
        )
      ).rows[0];
      if (!grant) throw new Error("Missing grant");
      expect(await decryptSecret(grant.value_enc, ENCRYPTION_KEY)).toBe(authentication);
    }
    for (const [authType, authentication] of [
      ["headers", "not-json"],
      ["headers", "[]"],
      ["headers", '{"X-Key":12}'],
      ["headers", '{"X-Key":"bad\\r\\nvalue"}'],
      ["oauth", "null"],
      ["oauth", "[]"],
      ["oauth", "not-json"],
      ["auto", "secret"],
      ["none", "secret"],
      ["bearer", "bad\nvalue"],
    ] as const) {
      await expect(registry.save(p.owner, p.org, { ...definition, authType, authentication })).rejects.toThrow();
    }
  } finally {
    await db.close();
  }
});

test("pending OAuth take is actor-bound, single-use and fenced by reconnect, expiry and membership", async () => {
  const { db, people: p } = await database();
  try {
    const { createSqlMcpPendingOAuthPort } = await import("@armada/core");
    const registry = createSqlMcpRegistry(db, ENCRYPTION_KEY);
    const grants = createSqlMcpGrantPort(db);
    const pending = createSqlMcpPendingOAuthPort(db, ENCRYPTION_KEY);
    const c = await registry.save(p.owner, p.org, {
      name: "OAuth",
      serviceId: "linear",
      scope: "personal",
      transport: "http",
      url: "https://mcp.example.com",
      authType: "oauth",
    });
    const fresh = await grants.begin(c.id);
    if (!fresh) throw new Error("Missing grant");
    const flow = {
      actorId: p.owner,
      orgId: p.org,
      connectionId: c.id,
      generation: fresh.generation,
      payload: '{"pkceVerifier":"sealed-flow-material"}',
      expiresAt: new Date("2100-01-01"),
      stateHash: "c".repeat(64),
    };
    await pending.put(flow);
    const parallel = await registry.save(p.owner, p.org, {
      name: "Parallel",
      scope: "personal",
      transport: "http",
      serviceId: "linear",
    });
    const parallelGrant = await grants.begin(parallel.id);
    if (!parallelGrant) throw Error("Missing parallel grant");
    await pending.put({
      ...flow,
      connectionId: parallel.id,
      generation: parallelGrant.generation,
      stateHash: "9".repeat(64),
    });
    await registry.metadata(p.owner, p.org, c.id, { name: "Rename during consent", defaultForLaunch: true });
    expect(await pending.take(p.owner, "9".repeat(64))).toMatchObject({ connectionId: parallel.id });
    const stored = (await db.query<{ payload_enc: Uint8Array }>("select payload_enc from mcp_pending_oauth")).rows[0];
    expect(new TextDecoder().decode(stored?.payload_enc)).not.toContain("sealed-flow-material");
    expect(await pending.take(p.member, flow.stateHash)).toBeNull();
    expect(await pending.take(p.owner, flow.stateHash)).toMatchObject({
      actorId: p.owner,
      connectionId: c.id,
      payload: flow.payload,
    });
    expect(await pending.take(p.owner, flow.stateHash)).toBeNull();
    await pending.put(flow);
    await grants.begin(c.id);
    expect(await pending.take(p.owner, flow.stateHash)).toBeNull();
    const current = await grants.begin(c.id);
    if (!current) throw new Error("Missing current grant");
    await pending.put({ ...flow, stateHash: "d".repeat(64), generation: current.generation });
    await db.query("update mcp_pending_oauth set expires_at=now()-interval '1 second' where hash=$1", ["d".repeat(64)]);
    expect(await pending.take(p.owner, "d".repeat(64))).toBeNull();
    await pending.put({ ...flow, stateHash: "e".repeat(64), generation: current.generation });
    await db.query("delete from members where org_id=$1 and user_id=$2", [p.org, p.owner]);
    expect(await pending.take(p.owner, "e".repeat(64))).toBeNull();
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [p.owner]);
    await expect(db.query("select * from mcp_pending_oauth")).rejects.toThrow(/permission denied/);
    await db.exec("reset role");
  } finally {
    await db.close();
  }
});

test("durable invalidations reach every replica independently and roll back with revocation", async () => {
  const { db, people: p } = await database();
  try {
    const { createSqlMcpInvalidationPort } = await import("@armada/core");
    const registry = createSqlMcpRegistry(db, ENCRYPTION_KEY);
    const feed = createSqlMcpInvalidationPort(db);
    const c = await registry.save(p.owner, p.org, {
      name: "Tools",
      scope: "personal",
      transport: "http",
      url: "https://mcp.example.com",
    });
    const a = crypto.randomUUID(),
      b = crypto.randomUUID();
    expect(await feed.pending(a)).toEqual([]);
    await db.exec("begin");
    await registry.revoke(p.owner, p.org, c.id);
    await db.exec("rollback");
    expect(await feed.pending(a)).toEqual([]);
    await registry.revoke(p.owner, p.org, c.id);
    const events = await feed.pending(a);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ connectionId: c.id, orgId: p.org, reason: "grant" });
    await feed.acknowledge(
      a,
      events.map((e) => e.id),
    );
    expect(await feed.pending(a)).toEqual([]);
    expect(await feed.pending(b)).toEqual(events);
    await registry.revoke(p.owner, p.org, c.id, true);
    expect((await feed.pending(a)).some((e) => e.reason === "definition" && e.connectionId === c.id)).toBe(true);
    await db.exec("set role authenticated");
    await expect(db.query("select * from mcp_invalidations")).rejects.toThrow(/permission denied/);
    await expect(db.query("select * from mcp_invalidation_deliveries")).rejects.toThrow(/permission denied/);
    await db.exec("reset role");
  } finally {
    await db.close();
  }
});

test("authenticated browser callback delegates without client org and binds to the pending actor", async () => {
  const { db, people: p } = await database();
  try {
    const { createSqlMcpPendingOAuthPort, createSqlVaultStore, VaultError } = await import("@armada/core");
    const { handleControlRequest } = await import("../src/control.ts");
    const registry = createSqlMcpRegistry(db, ENCRYPTION_KEY);
    const pending = createSqlMcpPendingOAuthPort(db, ENCRYPTION_KEY);
    const grants = createSqlMcpGrantPort(db);
    const c = await registry.save(p.owner, p.org, {
      name: "OAuth",
      scope: "personal",
      transport: "http",
      url: "https://mcp.example.com",
      authType: "oauth",
    });
    const current = await grants.begin(c.id);
    if (!current) throw new Error("Missing grant");
    const state = "f".repeat(64);
    await pending.put({
      stateHash: state,
      actorId: p.owner,
      orgId: p.org,
      connectionId: c.id,
      generation: current.generation,
      expiresAt: new Date("2100-01-01"),
      payload: "sealed PKCE",
    });
    const received: unknown[] = [];
    const broker: import("@armada/core").McpBrokerPort = {
      async connect() {
        throw new Error("Callback must not invoke connect");
      },
      async status() {
        throw new Error("Callback must not invoke status");
      },
      async callback(actorId, state, code, issuer) {
        const flow = await pending.take(actorId, state);
        if (!flow) throw new VaultError("not_found", "OAuth flow is no longer authorized.");
        received.push({ actorId, code, issuer });
        return { orgId: flow.orgId, connectionId: flow.connectionId, status: "not_connected" };
      },
    };
    const callback = async (actorId: string) => {
      const response = await handleControlRequest(
        new Request("https://armada.example.com/api/v1/mcp/oauth/callback", {
          method: "POST",
          headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig", "content-type": "application/json" },
          body: JSON.stringify({ state, code: "callback-test-code", issuer: "https://issuer.example.com" }),
        }),
        {
          authStore: createSqlAuthStore(db),
          supabase: {
            supabaseUrl: "https://project.supabase.co",
            anonKey: "public-anon",
            fetch: async () => Response.json({ id: actorId }),
          },
          encryptionKey: ENCRYPTION_KEY,
          store: createSqlVaultStore(db),
          mcp: { registry, broker },
        },
      );
      if (!response) throw new Error("Callback not mounted");
      return response;
    };
    expect((await callback(p.member)).status).toBe(404);
    const response = await callback(p.owner);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connection: { id: c.id, orgId: p.org, status: "not_connected" } });
    expect(received).toEqual([{ actorId: p.owner, code: "callback-test-code", issuer: "https://issuer.example.com" }]);
    expect((await callback(p.owner)).status).toBe(404);
  } finally {
    await db.close();
  }
});

test("canonical control lifecycle toggles fence tokens and bindings reflect authorized current state", async () => {
  const { db, people: p } = await database();
  try {
    const { createSqlVaultStore, createSqlMcpPendingOAuthPort, createSqlMcpInvalidationPort, encryptSecret } =
      await import("@armada/core");
    const { handleControlRequest } = await import("../src/control.ts");
    const registry = createSqlMcpRegistry(db, ENCRYPTION_KEY);
    const grants = createSqlMcpGrantPort(db);
    const pending = createSqlMcpPendingOAuthPort(db, ENCRYPTION_KEY);
    const leases = createSqlMcpLeasePort(db);
    const feed = createSqlMcpInvalidationPort(db);
    const personal = await registry.save(p.owner, p.org, {
      name: "Personal",
      scope: "personal",
      transport: "http",
      url: "https://mcp.example.com",
      authType: "oauth",
    });
    const shared = await registry.save(p.admin, p.org, {
      name: "Shared",
      scope: "org",
      transport: "http",
      url: "https://mcp.example.com",
    });
    const sharedGeneration = await grants.begin(shared.id);
    if (!sharedGeneration) throw new Error("Missing shared grant");
    await grants.discovered(shared.id, sharedGeneration.generation, "none");
    const fresh = await grants.begin(personal.id);
    const owner = crypto.randomUUID();
    const claim = await grants.acquire(personal.id, owner);
    if (!fresh || !claim) throw new Error("Missing personal grant");
    const authentication = '{"accessToken":"lifecycle-test-only","refreshToken":"lifecycle-refresh-only"}';
    expect(
      await grants.rotate(
        claim.id,
        owner,
        claim.version,
        claim.generation,
        await encryptSecret(authentication, ENCRYPTION_KEY),
      ),
    ).toBe(true);
    const golden = (await db.query<{ id: string }>("select id from goldens where name='shared' and provider='boat'"))
      .rows[0];
    if (!golden) throw new Error("Missing golden");
    const sandbox = crypto.randomUUID(),
      orgSandbox = crypto.randomUUID(),
      empty = crypto.randomUUID();
    for (const [id, visibility] of [
      [sandbox, "private"],
      [orgSandbox, "org"],
      [empty, "private"],
    ]) {
      await db.query(
        "insert into sandboxes(id,boat_id,golden_id,org_id,owner_id,harness,status,visibility) values($1,$2,$3,$4,$5,'claude','ready',$6::public.visibility)",
        [id, "bx_" + id, golden.id, p.org, p.owner, visibility],
      );
    }
    const launch = createSqlMcpLaunchPort(db, registry);
    await launch.bind(sandbox, [personal.id, shared.id]);
    await launch.bind(orgSandbox, [shared.id]);
    const tokenHash = "9".repeat(64);
    await leases.issue({
      sandboxId: sandbox,
      connectionId: personal.id,
      tokenHash,
      operations: ["tools"],
      expiresAt: new Date("2100-01-01"),
    });
    await pending.put({
      actorId: p.owner,
      orgId: p.org,
      connectionId: personal.id,
      generation: claim.generation,
      payload: "sealed pending",
      expiresAt: new Date("2100-01-01"),
      stateHash: "8".repeat(64),
    });
    const uncertainOwner = crypto.randomUUID();
    const uncertain = await grants.acquire(personal.id, uncertainOwner);
    if (!uncertain) throw new Error("Missing refresh claim");
    await db.query("update mcp_grants set refresh_until=now()-interval '1 second' where id=$1", [uncertain.id]);
    const call = async (actorId: string, action: string, body: Record<string, unknown>) => {
      const response = await handleControlRequest(
        new Request(`https://armada.example.com/api/v1/mcp/${action}`, {
          method: "POST",
          headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig", "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        {
          authStore: createSqlAuthStore(db),
          supabase: {
            supabaseUrl: "https://project.supabase.co",
            anonKey: "public-anon",
            fetch: async () => Response.json({ id: actorId }),
          },
          encryptionKey: ENCRYPTION_KEY,
          store: createSqlVaultStore(db),
          data: createSqlData(db),
          mcp: { registry },
        },
      );
      if (!response) throw new Error("Canonical control route missing");
      return {
        status: response.status,
        body: (await response.json()) as {
          connection: import("@armada/core").McpConnectionDto;
          connections: import("@armada/core").McpConnectionDto[];
        },
      };
    };
    const before = await call(p.owner, "sandbox-connections", { org: p.org, id: sandbox });
    expect(before.body.connections.map((c) => [c.id, c.status])).toEqual([
      [personal.id, "needs_reconnect"],
      [shared.id, "connected"],
    ]);
    expect((await call(p.owner, "sandbox-connections", { org: p.org, id: empty })).body.connections).toEqual([]);
    for (const actor of [p.member])
      expect((await call(actor, "sandbox-connections", { org: p.org, id: sandbox })).status).toBe(404);
    expect((await call(p.member, "sandbox-connections", { org: p.org, id: orgSandbox })).status).toBe(404);
    expect(
      (await call(p.admin, "sandbox-connections", { org: p.org, id: orgSandbox })).body.connections.map((c) => c.id),
    ).toEqual([shared.id]);
    expect((await call(p.member, "sandbox-connections", { org: p.otherOrg, id: orgSandbox })).status).toBe(404);
    expect((await call(p.member, "set-enabled", { org: p.org, id: shared.id, enabled: false })).status).toBe(403);
    expect((await call(p.member, "set-enabled", { org: p.org, id: personal.id, enabled: false })).status).toBe(404);
    expect((await call(p.owner, "set-enabled", { org: p.org, id: personal.id, enabled: "false" })).status).toBe(400);
    const replica = crypto.randomUUID();
    await feed.acknowledge(
      replica,
      (await feed.pending(replica)).map((e) => e.id),
    );
    await db.query("update mcp_grants set refresh_until=now()+interval '30 seconds' where id=$1", [uncertain.id]);
    expect(await leases.validate(tokenHash, "tools")).not.toBeNull();
    const disabled = await call(p.owner, "set-enabled", { org: p.org, id: personal.id, enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.connection.status).toBe("disabled");
    expect((await call(p.owner, "status", { org: p.org, id: personal.id })).body.connection.status).toBe("disabled");
    expect((await call(p.owner, "connect", { org: p.org, id: personal.id })).status).toBe(409);
    expect(await leases.validate(tokenHash, "tools")).toBeNull();
    expect(await pending.take(p.owner, "8".repeat(64))).toBeNull();
    expect(await grants.begin(personal.id)).toBeNull();
    expect(await grants.acquire(personal.id, crypto.randomUUID())).toBeNull();
    expect(await grants.rotate(uncertain.id, uncertainOwner, uncertain.version, uncertain.generation, null)).toBe(
      false,
    );
    expect((await feed.pending(replica)).some((e) => e.connectionId === personal.id)).toBe(true);
    expect((await call(p.owner, "sandbox-connections", { org: p.org, id: sandbox })).body.connections[0]?.status).toBe(
      "disabled",
    );
    const enabled = await call(p.owner, "set-enabled", { org: p.org, id: personal.id, enabled: true });
    expect(enabled.body.connection.status).toBe("not_connected");
    expect(await grants.acquire(personal.id, crypto.randomUUID())).toBeNull();
    const stored = (
      await db.query<{ value_enc: Uint8Array | null; generation: number }>(
        "select value_enc,generation from mcp_grants where connection_id=$1",
        [personal.id],
      )
    ).rows[0];
    expect(stored?.value_enc).toBeNull();
    await call(p.owner, "set-enabled", { org: p.org, id: personal.id, enabled: true });
    expect(
      (
        await db.query<{ generation: number }>("select generation from mcp_grants where connection_id=$1", [
          personal.id,
        ])
      ).rows[0]?.generation,
    ).toBe(stored?.generation);
    await registry.revoke(p.admin, p.org, shared.id);
    const revoked = await call(p.owner, "sandbox-connections", { org: p.org, id: sandbox });
    expect(revoked.body.connections.map((c) => c.status)).toEqual(["not_connected", "not_connected"]);
    expect(JSON.stringify(revoked.body)).not.toContain("lifecycle-test-only");
    expect(
      (await call(p.admin, "set-enabled", { org: p.org, id: shared.id, enabled: false })).body.connection.status,
    ).toBe("disabled");
    expect(
      (await call(p.admin, "sandbox-connections", { org: p.org, id: orgSandbox })).body.connections[0]?.status,
    ).toBe("disabled");
    expect(
      (await call(p.admin, "set-enabled", { org: p.org, id: shared.id, enabled: true })).body.connection.status,
    ).toBe("not_connected");
    expect(await grants.acquire(shared.id, crypto.randomUUID())).toBeNull();
    await db.query("delete from members where org_id=$1 and user_id=$2", [p.org, p.owner]);
    expect((await call(p.owner, "sandbox-connections", { org: p.org, id: sandbox })).status).toBe(404);
  } finally {
    await db.close();
  }
});

test("membership changes permanently fence only the actor's org leases, with fresh admission after rejoin", async () => {
  const { db, people: p } = await database();
  try {
    const registry = createSqlMcpRegistry(db, ENCRYPTION_KEY),
      grants = createSqlMcpGrantPort(db),
      leases = createSqlMcpLeasePort(db),
      launch = createSqlMcpLaunchPort(db, registry);
    const connection = await registry.save(p.admin, p.org, {
      name: "Shared",
      scope: "org",
      transport: "http",
      url: "https://mcp.example.com",
    });
    const initial = await grants.begin(connection.id);
    if (!initial) throw new Error("Missing grant");
    await grants.discovered(connection.id, initial.generation, "none");
    const golden = (
      await db.query<{ id: string }>("select id from goldens where org_id=$1 and visibility='org'", [p.org])
    ).rows[0];
    if (!golden) throw new Error("Missing golden");
    const actorSandbox = crypto.randomUUID(),
      otherSandbox = crypto.randomUUID();
    const admission = async (
      sandboxId: string,
      ownerId: string,
      hash: string,
      orgId = p.org,
      connectionId = connection.id,
      goldenId = golden.id,
    ) => {
      await db.query(
        "insert into sandboxes(id,boat_id,golden_id,org_id,owner_id,harness,status,visibility) values($1,$2,$3,$4,$5,'claude','ready','org')",
        [sandboxId, `bx_${sandboxId}`, goldenId, orgId, ownerId],
      );
      await launch.bind(sandboxId, [connectionId]);
      await leases.issue({
        sandboxId,
        connectionId,
        tokenHash: hash,
        operations: ["tools"],
        expiresAt: new Date("2100-01-01"),
      });
    };
    const actorHash = "4".repeat(64),
      otherHash = "5".repeat(64);
    await admission(actorSandbox, p.owner, actorHash);
    await admission(otherSandbox, p.member, otherHash);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [p.otherOrg, p.owner]);
    const otherOrgConnection = await registry.save(p.member, p.otherOrg, {
      name: "Other org",
      scope: "org",
      transport: "http",
      url: "https://mcp.example.com",
    });
    const otherOrgGrant = await grants.begin(otherOrgConnection.id);
    if (!otherOrgGrant) throw new Error("Missing other-org grant");
    await grants.discovered(otherOrgConnection.id, otherOrgGrant.generation, "none");
    const otherGolden = crypto.randomUUID();
    await db.query(
      "insert into goldens(id,org_id,owner_id,name,visibility,config) select $1,$2,$3,'other-org-golden','org',config from goldens where id=$4",
      [otherGolden, p.otherOrg, p.member, golden.id],
    );
    const otherOrgHash = "3".repeat(64);
    await admission(crypto.randomUUID(), p.owner, otherOrgHash, p.otherOrg, otherOrgConnection.id, otherGolden);
    const { createSqlMcpInvalidationPort } = await import("@armada/core");
    const feed = createSqlMcpInvalidationPort(db),
      replica = crypto.randomUUID();
    await feed.acknowledge(
      replica,
      (await feed.pending(replica)).map((e) => e.id),
    );
    expect(await leases.validate(actorHash, "tools")).not.toBeNull();
    await db.query("delete from members where org_id=$1 and user_id=$2", [p.org, p.owner]);
    expect(await leases.validate(actorHash, "tools")).toBeNull();
    expect(await leases.validate(otherHash, "tools")).not.toBeNull();
    expect(await leases.validate(otherOrgHash, "tools")).not.toBeNull();
    const invalidations = await feed.pending(replica);
    expect(invalidations.some((e) => e.sandboxId === actorSandbox)).toBe(true);
    expect(
      invalidations.every((e) => e.orgId === p.org && e.sandboxId === actorSandbox && e.connectionId === null),
    ).toBe(true);
    await expect(
      leases.issue({
        sandboxId: actorSandbox,
        connectionId: connection.id,
        tokenHash: "6".repeat(64),
        operations: ["tools"],
        expiresAt: new Date("2100-01-01"),
      }),
    ).rejects.toThrow();
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [p.org, p.owner]);
    expect(await leases.validate(actorHash, "tools")).toBeNull();
    expect(await leases.validate(otherHash, "tools")).not.toBeNull();
    const freshHash = "6".repeat(64);
    await launch.validate({ userId: p.owner, orgId: p.org }, [connection.id], "org");
    await leases.issue({
      sandboxId: actorSandbox,
      connectionId: connection.id,
      tokenHash: freshHash,
      operations: ["tools"],
      expiresAt: new Date("2100-01-01"),
    });
    expect(await leases.validate(freshHash, "tools")).not.toBeNull();
    await db.query("update members set role='admin' where org_id=$1 and user_id=$2", [p.org, p.owner]);
    expect(await leases.validate(freshHash, "tools")).toBeNull();
    await db.query("update members set role='member' where org_id=$1 and user_id=$2", [p.org, p.owner]);
    expect(await leases.validate(freshHash, "tools")).toBeNull();
    expect(await leases.validate(otherHash, "tools")).not.toBeNull();
    expect((await registry.get(p.member, p.org, connection.id)).status).toBe("connected");
    expect(await leases.validate(otherOrgHash, "tools")).not.toBeNull();
  } finally {
    await db.close();
  }
});

test("stdio is configured locally from a pinned definition, then explicitly reconfigured after enable", async () => {
  const { db, people: p } = await database();
  try {
    const { createSqlVaultStore } = await import("@armada/core");
    const { handleControlRequest } = await import("../src/control.ts");
    const registry = createSqlMcpRegistry(db, ENCRYPTION_KEY);
    const call = async (action: string, body: Record<string, unknown>) => {
      const response = await handleControlRequest(
        new Request(`https://armada.example.com/api/v1/mcp/${action}`, {
          method: "POST",
          headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig", "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        {
          authStore: createSqlAuthStore(db),
          supabase: {
            supabaseUrl: "https://project.supabase.co",
            anonKey: "public-anon",
            fetch: async () => Response.json({ id: p.owner }),
          },
          store: createSqlVaultStore(db),
          encryptionKey: ENCRYPTION_KEY,
          mcp: { registry },
        },
      );
      if (!response) throw new Error("Missing stdio control route");
      return {
        status: response.status,
        body: (await response.json()) as { connection: import("@armada/core").McpConnectionDto },
      };
    };
    const definition = {
      name: "Filesystem",
      scope: "personal",
      transport: "stdio",
      command: "npx",
      args: ["--yes", "@modelcontextprotocol/server-filesystem@2026.1.0", "/workspace"],
    };
    const saved = await call("create", { org: p.org, ...definition });
    expect(saved.status).toBe(200);
    expect(saved.body.connection).toMatchObject({ transport: "stdio", authType: "none", status: "connected" });
    expect(saved.body.connection.toolCount).toBeUndefined();
    const id = saved.body.connection.id;
    const grants = createSqlMcpGrantPort(db);
    const refreshOwner = crypto.randomUUID();
    const snapshot = await grants.acquire(id, refreshOwner);
    if (!snapshot) throw new Error("Missing stdio grant");
    const disabled = await call("set-enabled", { org: p.org, id, enabled: false });
    expect(disabled.body.connection.status).toBe("disabled");
    expect((await call("connect", { org: p.org, id })).status).toBe(409);
    expect((await call("set-enabled", { org: p.org, id, enabled: true })).body.connection.status).toBe("not_connected");
    expect((await call("status", { org: p.org, id })).body.connection.status).toBe("not_connected");
    const configured = await call("connect", { org: p.org, id });
    expect(configured.body.connection.status).toBe("connected");
    expect((await call("status", { org: p.org, id })).body.connection.status).toBe("connected");
    expect(await grants.rotate(snapshot.id, refreshOwner, snapshot.version, snapshot.generation, null)).toBe(false);
    for (const invalid of [
      { command: "bash", args: ["-c", "anything"] },
      { command: "npx", args: ["server@latest"] },
      { command: "npx", args: ["server@^1.2.3"] },
      { command: "uvx", args: ["server"] },
      { authType: "bearer", authentication: "not-supported" },
      { authType: "none", authentication: "not-supported" },
    ]) {
      expect((await call("create", { org: p.org, ...definition, ...invalid })).status).toBe(400);
    }
    expect(
      (await call("create", { org: p.org, ...definition, command: "uvx", args: ["mcp-server-git==2026.1.0"] })).body
        .connection.status,
    ).toBe("connected");
    expect((await call("update", { org: p.org, id, name: "Incomplete edit" })).status).toBe(400);
    expect((await call("update", { org: p.org, id, ...definition, name: "Renamed" })).body.connection.status).toBe(
      "connected",
    );
  } finally {
    await db.close();
  }
});

test("catalog instances have independent defaults and metadata does not replace authentication", async () => {
  const { db, people: p } = await database();
  try {
    const registry = createSqlMcpRegistry(db, ENCRYPTION_KEY);
    const input = {
      serviceId: "linear" as const,
      name: "Work",
      scope: "personal" as const,
      transport: "http" as const,
      url: "https://untrusted.example",
    };
    const first = await registry.save(p.owner, p.org, input);
    const second = await registry.save(p.owner, p.org, { ...input, name: "Other" });
    expect(first.id).not.toBe(second.id);
    expect(first.url).toBe("https://mcp.linear.app/mcp");
    expect(first.catalogId).toBe("linear");
    const before = (await db.query("select * from mcp_grants where connection_id=$1", [first.id])).rows;
    await registry.metadata(p.owner, p.org, first.id, { name: "Renamed", defaultForLaunch: true });
    expect((await db.query("select * from mcp_grants where connection_id=$1", [first.id])).rows).toEqual(before);
    const port = createSqlMcpLaunchPort(db, registry);
    const actor = { userId: p.owner, orgId: p.org };
    expect(await port.defaults(actor, "private")).toEqual([first.id]);
    expect(await port.defaults(actor, "org")).toEqual([first.id]);
    await expect(port.validate(actor, [first.id], "private")).rejects.toThrow(/reconnect/);
    await expect(registry.metadata(p.member, p.org, first.id, { name: "Stolen" })).rejects.toThrow();
    const shared = await registry.save(p.admin, p.org, { ...input, scope: "org" });
    await expect(registry.metadata(p.member, p.org, shared.id, { defaultForLaunch: true })).rejects.toThrow(
      /administrator/,
    );
    await registry.setEnabled(p.owner, p.org, first.id, false);
    expect(await port.defaults(actor, "private")).toEqual([]);
    await expect(registry.save(p.owner, p.org, { ...input, serviceId: "slack" })).rejects.toThrow(/setup required/);
  } finally {
    await db.close();
  }
});

test("metadata UPDATE refuses authority revoked after its pre-read", async () => {
  for (const scope of ["personal", "org"] as const) {
    const { db, people: p } = await database();
    try {
      const actor = scope === "personal" ? p.owner : p.admin;
      const registry = createSqlMcpRegistry(db, ENCRYPTION_KEY);
      const connection = await registry.save(actor, p.org, {
        name: "Unchanged",
        scope,
        transport: "http",
        serviceId: "linear",
      });
      let revoked = false;
      // Commit the authority change immediately before the real SQL mutation executes.
      const boundary: Sql = {
        async query<T>(statement: string, params?: unknown[]) {
          if (!revoked && /^update public\.mcp_connections/i.test(statement.trim())) {
            revoked = true;
            if (scope === "personal")
              await db.query("delete from members where user_id=$1 and org_id=$2", [actor, p.org]);
            else await db.query("update members set role='member' where user_id=$1 and org_id=$2", [actor, p.org]);
          }
          return db.query<T>(statement, params);
        },
      };
      const racing = createSqlMcpRegistry(boundary, ENCRYPTION_KEY);
      const outcome = await racing
        .metadata(actor, p.org, connection.id, { name: "Unauthorized", defaultForLaunch: true })
        .catch((error) => error);
      expect(revoked).toBe(true);
      expect(
        (await db.query("select name,default_for_launch from mcp_connections where id=$1", [connection.id])).rows,
      ).toEqual([{ name: "Unchanged", default_for_launch: false }]);
      expect(outcome).toBeInstanceOf(Error);
    } finally {
      await db.close();
    }
  }
});
