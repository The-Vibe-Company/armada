import { expect, test } from "bun:test";
import { createMemoryAuthStore, generateToken, sha256Hex } from "@armada/auth";
import { type CredentialReader, createSqlVaultStore, encryptSecret, type Sql } from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createHandler } from "../src/http.ts";
import { createProviderMetadata } from "../src/provider-metadata.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

test("HTTP and MCP read Modal capacity before any App exists without provisioning; token scope precedes secret reads", async () => {
  const { db, people } = await database();
  let server: ReturnType<typeof Bun.serve> | undefined;
  let client: Client | undefined;
  try {
    const pair = { token_id: "ak-orgcapability1", token_secret: "as-orgcapability1" };
    await db.query(
      "insert into credentials(scope,owner_id,kind,value_enc) values('org',$1,'modal',$2),('user',$3,'modal',$2)",
      [people.org, await encryptSecret(JSON.stringify(pair), ENCRYPTION_KEY), people.member],
    );
    const writes: string[] = [];
    const resourceAccesses: string[] = [];
    const readSql: Sql = {
      query: async (text, params) => {
        if (!/^\s*select\b/i.test(text)) writes.push(text);
        if (
          /golden_backend_slots|(?:reserve|finalize|release)_golden_backend_slot|modal_machines|modal_images|modal_server_apps|modal_server_scopes/i.test(
            text,
          )
        )
          resourceAccesses.push(text);
        return db.query(text, params);
      },
    };
    const stored = createSqlVaultStore(readSql);
    let secretReads = 0;
    const vault: CredentialReader = {
      credentials: async (...args) => {
        secretReads++;
        return stored.credentials(...args);
      },
      orgBoatKey: async (...args) => {
        secretReads++;
        return stored.orgBoatKey(...args);
      },
    };
    const metadata = createProviderMetadata({
      sql: readSql,
      vault,
      encryptionKey: ENCRYPTION_KEY,
      providerFor: (apiKey) => createBoatProvider({ apiKey }),
    });
    const auth = createMemoryAuthStore();
    auth.addMembership(people.member, { orgId: people.org, name: "Example", role: "member" });
    auth.addMembership(people.member, { orgId: people.otherOrg, name: "Other", role: "admin" });
    const token = generateToken("service");
    await auth.insertToken("service", {
      userId: people.member,
      orgId: people.org,
      hash: await sha256Hex(token),
      label: "metadata",
      createdAt: new Date().toISOString(),
    });
    let resourceCalls = 0;
    let appCreates = 0;
    const providerFor = () => {
      resourceCalls++;
      throw new Error("Resource factory must not run for metadata.");
    };
    const data = createSqlData(readSql);
    const supabase = { supabaseUrl: "https://supabase.invalid", anonKey: "anon" };
    const control: ControlOptions = {
      authStore: auth,
      supabase,
      store: stored,
      data,
      encryptionKey: ENCRYPTION_KEY,
      providerMetadata: metadata,
      providerFor,
    };
    const handler = createHandler({
      publicUrl: "https://armada.test",
      authStore: auth,
      supabase,
      oauth: {
        store: auth,
        fetch: async () => new Response(null, { status: 500 }),
        now: () => new Date(),
        ...supabase,
        authSecret: "fixture-long-auth-secret",
        publicUrl: "https://armada.test",
      },
      data,
      vault,
      encryptionKey: ENCRYPTION_KEY,
      providerFor,
      providerMetadata: metadata,
      modalProviderFor: async () => {
        resourceCalls++;
        throw new Error("App-bound adapter must not run.");
      },
      goldenTarget: async () => {
        appCreates++;
        throw new Error("Metadata must not provision an App.");
      },
      routes: [(request) => handleControlRequest(request, control)],
      log: () => {},
    });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    const request = (body: object) =>
      fetch(new URL("/api/v1/golden/capabilities", server!.url), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const api = await request({ provider: "modal", org: people.org });
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ provider: "modal", maxGoldens: null });
    client = new Client({ name: "capability-http-regression", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", server.url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === "golden_capabilities")?.annotations?.readOnlyHint).toBe(true);
    const result = await client.callTool({
      name: "golden_capabilities",
      arguments: { provider: "modal", org: people.org },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ provider: "modal", maxGoldens: null });
    const beforeForgery = secretReads;
    const forged = await request({ provider: "modal", org: people.otherOrg });
    expect(forged.status).toBe(403);
    const forgedMcp = await client.callTool({
      name: "golden_capabilities",
      arguments: { provider: "modal", org: people.otherOrg },
    });
    expect(forgedMcp.isError).toBe(true);
    expect(secretReads).toBe(beforeForgery);
    expect(await (await request({ provider: "boat" })).json()).toEqual({ provider: "boat", maxGoldens: 1 });
    // A personal pair is deliberately not an org credential fallback for this read.
    await db.query("delete from credentials where scope='org' and owner_id=$1 and kind='modal'", [people.org]);
    const removed = await request({ provider: "modal" });
    expect(removed.status).not.toBe(200);
    expect(await removed.json()).toMatchObject({ error: { code: "missing_credential" } });
    const removedMcp = await client.callTool({ name: "golden_capabilities", arguments: { provider: "modal" } });
    expect(removedMcp.isError).toBe(true);
    expect(JSON.stringify(removedMcp)).toContain("missing_credential");
    expect(resourceCalls).toBe(0);
    expect(appCreates).toBe(0);
    expect(writes).toEqual([]);
    expect(resourceAccesses).toEqual([]);
    for (const table of [
      "modal_server_apps",
      "modal_machines",
      "modal_images",
      "modal_server_scopes",
      "golden_backend_slots",
    ])
      expect((await db.query(`select count(*)::int as count from ${table}`)).rows).toEqual([{ count: 0 }]);
    expect(JSON.stringify(result)).not.toContain(pair.token_secret);
  } finally {
    await client?.close();
    await server?.stop(true);
    await db.close();
  }
});
