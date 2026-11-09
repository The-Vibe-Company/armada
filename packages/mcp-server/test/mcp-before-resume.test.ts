import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceToken, createSqlAuthStore, sha256Hex } from "@armada/auth";
import { createSqlMcpLeasePort, createSqlSandboxStore } from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { sandbox as boatSandbox } from "../../provider-boat/test/support.ts";
import { createMcpHttpIntegration } from "../src/mcp-http-integration.ts";
import { createMcpLifecycle } from "../src/mcp-lifecycle.ts";
import { nativeMcpInstallScript } from "../src/mcp-native.ts";

// Boat actually preserves boot_id across archive/restore: authority must be fenced
// before a possibly ambiguous resume, not inferred only from kernel identity.
test("same-boot autoarchive fences SQL leases before Boat resume and reinstalls only after readiness", async () => {
  const db = await openDatabase();
  const home = await mkdtemp(join(tmpdir(), "armada-sameboot-"));
  const servers: McpServer[] = [];
  let service: ReturnType<typeof createMcpHttpIntegration> | undefined;
  try {
    await applyMigrations(db);
    const user = crypto.randomUUID(),
      other = crypto.randomUUID(),
      org = crypto.randomUUID(),
      golden = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1),($2)", [user, other]);
    await db.query("insert into public.orgs(id,name) values($1,'Same boot')", [org]);
    await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'admin')", [
      org,
      user,
      other,
    ]);
    await db.query(
      "insert into public.goldens(id,org_id,owner_id,name,visibility) values($1,$2,$3,'sameboot','private')",
      [golden, org, user],
    );
    const record = await createSqlSandboxStore(db).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "bx_sameboot_fixture",
      goldenId: golden,
      orgId: org,
      ownerId: user,
      visibility: "private",
      harness: "codex",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
      status: "ready",
    });
    const authStore = createSqlAuthStore(db);
    const { token } = await createServiceToken(authStore, { userId: user, now: new Date() });
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    service = createMcpHttpIntegration({
      sql: db,
      authStore,
      encryptionKey: key,
      publicUrl: "https://gateway.example",
      supabase: { supabaseUrl: "https://auth.example", anonKey: "public" },
      fetch: async (input, init) => {
        const server = new McpServer({ name: "Real discovery", version: "1" });
        server.registerTool("proof", {}, async () => ({ content: [{ type: "text", text: "proof" }] }));
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        await server.connect(transport);
        servers.push(server);
        return transport.handleRequest(new Request(String(input), init));
      },
    });
    const integration = service;
    const post = async (action: string, body: object) => {
      const response = await integration.route(
        new Request(`https://gateway.example/api/v1/mcp/${action}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ org, ...body }),
        }),
      );
      expect(response?.status).toBe(200);
      return (await response?.json()) as { connection: { id: string; status: string } };
    };
    const { connection } = await post("create", {
      name: "Public",
      scope: "personal",
      transport: "http",
      url: "https://upstream.example/mcp",
    });
    expect((await post("connect", { id: connection.id })).connection.status).toBe("connected");
    await integration.connections.bind(record.id, [connection.id]);
    const actor = { userId: user, orgId: org };
    const replica = () =>
      createMcpLifecycle({
        sql: db,
        encryptionKey: key,
        origin: "https://gateway.example",
        registry: integration.registry,
      });
    const leases = createSqlMcpLeasePort(db);
    let state = "ready",
      writes = 0,
      turns = 0,
      resumes = 0,
      ambiguous = true;
    let previousHash = "";
    const generation = async () =>
      (
        await db.query<{ mcp_generation: number }>("select mcp_generation from public.sandboxes where id=$1", [
          record.id,
        ])
      ).rows[0]?.mcp_generation ?? -1;
    const configured = async () =>
      (
        await db.query<{ configured: boolean }>("select configured from public.mcp_bootstraps where sandbox_id=$1", [
          record.id,
        ])
      ).rows[0]?.configured;
    const installedHash = async () => {
      const config = JSON.parse(await readFile(join(home, ".claude.json"), "utf8")) as {
        mcpServers: Record<string, { headers: { Authorization: string } }>;
      };
      return sha256Hex(Object.values(config.mcpServers)[0]?.headers.Authorization.slice(7) ?? "");
    };
    let delayedHook: (() => Promise<void>) | undefined;
    const provider = createBoatProvider({
      apiKey: "boat_fixture_not_real",
      sleep: async () => {},
      beforeResume: async (p, id) => {
        const wait = delayedHook;
        delayedHook = undefined;
        await wait?.();
        return integration.beforeResume(p, id, actor);
      },
      beforePrompt: async (p, id) => integration.beforePrompt(p, id, actor),
      fetch: (async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (init?.method === "GET")
          return Response.json({
            sandbox: boatSandbox({
              id: record.providerSandboxId,
              state,
              archiveAfter: new Date(Date.now() + 3600000).toISOString(),
            }),
          });
        if (path.endsWith("/commands")) {
          const command = JSON.parse(String(init?.body)).command as string;
          if (command.includes("armada-wrapper"))
            return Response.json({
              ok: true,
              type: "command.finished",
              success: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              timedOut: false,
            });
          expect(command).toBe("cat /proc/sys/kernel/random/boot_id");
          return Response.json({
            ok: true,
            type: "command.finished",
            success: true,
            exitCode: 0,
            stdout: "11111111-1111-4111-8111-111111111111\n",
            stderr: "",
            timedOut: false,
          });
        }
        if (path.endsWith("/resume")) {
          if (state === "ready")
            return Response.json(
              { ok: false, type: "sandbox.error", status: 409, code: "conflict", message: "Already ready" },
              { status: 409 },
            );
          resumes++;
          expect(await leases.validate(previousHash, "tools")).toBeNull();
          expect(await configured()).toBe(false);
          expect(writes).toBe(resumes); // No installer ran during the stopped/pre-resume window.
          state = "ready";
          if (ambiguous) {
            ambiguous = false;
            throw Error("Network outcome unknown");
          }
          return Response.json({ ok: true });
        }
        if (path.endsWith("/prompt")) {
          turns++;
          expect(await configured()).toBe(true);
          expect(await leases.validate(await installedHash(), "tools")).not.toBeNull();
          return Response.json({ promptId: "p", conversationId: "c", status: "queued" });
        }
        throw Error("Unexpected provider operation");
      }) as typeof fetch,
    });
    provider.configureMcp = async ({ configuration }) => {
      expect(state).toBe("ready");
      const child = Bun.spawn(["bash"], {
        stdin: new Blob([nativeMcpInstallScript]),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: home, ARMADA_GIT_TOKEN: JSON.stringify(configuration) },
      });
      expect(await child.exited).toBe(0);
      writes++;
    };
    await integration.connections.prepare?.(provider, record, { ...actor, role: "admin" });
    previousHash = await installedHash();
    expect(await leases.validate(previousHash, "tools")).not.toBeNull();
    const initial = await generation();
    for (const caller of [
      { userId: other, orgId: org },
      { userId: user, orgId: crypto.randomUUID() },
    ]) {
      await expect(replica().beforeResume(provider, record.providerSandboxId, caller)).rejects.toThrow("authorized");
    }
    await expect(
      replica().beforePrompt(provider, record.providerSandboxId, { userId: other, orgId: org }),
    ).rejects.toThrow("authorized");
    await expect(
      integration.connections.prepare?.(provider, record, { userId: other, orgId: org, role: "admin" }),
    ).rejects.toThrow("authorized");
    expect(writes).toBe(1);
    expect(await generation()).toBe(initial);
    // Platform autoarchive: deliberately NO Armada SQL status/stopped_at write.
    state = "archived";
    expect(
      (await db.query<{ status: string }>("select status from public.sandboxes where id=$1", [record.id])).rows[0]
        ?.status,
    ).toBe("ready");
    await Promise.all([
      replica().beforeResume(provider, record.providerSandboxId, actor),
      replica().beforeResume(provider, record.providerSandboxId, actor),
    ]);
    expect(await generation()).toBe(initial + 1);
    expect(await leases.validate(previousHash, "tools")).toBeNull();
    expect(writes).toBe(1);
    const prompt = () =>
      provider.prompt({ sandboxId: record.providerSandboxId, harness: "codex", text: "Use MCP", conversationId: "c" });
    await expect(prompt()).rejects.toThrow(); // Resume happened, response lost, fence stays committed.
    expect(turns).toBe(0);
    expect(writes).toBe(1);
    await prompt(); // Now-ready retry MUST replace config despite identical boot UUID.
    let fresh = await installedHash();
    expect(fresh === previousHash).toBe(false);
    expect(await leases.validate(previousHash, "tools")).toBeNull();
    expect(await generation()).toBe(initial + 1);
    expect(writes).toBe(2);
    await Promise.all([prompt(), prompt()]);
    expect(await installedHash()).toBe(fresh);
    expect(writes).toBe(2);
    expect(resumes).toBe(1);
    // B observes stopped FIRST, but its hook runs only AFTER A has fenced,
    // resumed, reconfigured and started a native turn. No sleeps or fake receipts.
    previousHash = fresh;
    state = "archived";
    let releaseB!: () => void, observedB!: () => void;
    const bObserved = new Promise<void>((resolve) => {
      observedB = resolve;
    });
    const bRelease = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    delayedHook = async () => {
      observedB();
      await bRelease;
    };
    const delayedB = prompt();
    await bObserved;
    const beforeRace = await generation();
    await prompt(); // A completes resume + configuration + native turn.
    const aHash = await installedHash();
    expect(await leases.validate(previousHash, "tools")).toBeNull();
    expect(await leases.validate(aHash, "tools")).not.toBeNull();
    expect(await generation()).toBe(beforeRace + 1);
    const aWrites = writes,
      aResumes = resumes;
    releaseB();
    await delayedB;
    expect(await generation()).toBe(beforeRace + 1);
    expect(await leases.validate(aHash, "tools")).not.toBeNull();
    expect(await installedHash()).toBe(aHash);
    expect(writes).toBe(aWrites);
    expect(resumes).toBe(aResumes);
    fresh = aHash;
    // Known stop also persists stopped_at; same-boot resume clears it BEFORE the model turn.
    previousHash = fresh;
    state = "archived";
    await db.query("update public.sandboxes set status='stopped',stopped_at=now() where id=$1", [record.id]);
    expect(
      (await db.query<{ stopped_at: Date | null }>("select stopped_at from public.sandboxes where id=$1", [record.id]))
        .rows[0]?.stopped_at,
    ).not.toBeNull();
    await prompt();
    expect(
      (
        await db.query<{ status: string; stopped_at: Date | null }>(
          "select status,stopped_at from public.sandboxes where id=$1",
          [record.id],
        )
      ).rows[0],
    ).toMatchObject({ status: "ready", stopped_at: null });
    expect((await installedHash()) === fresh).toBe(false);
    // An authorized VM with no bootstrap/lease must not churn generations.
    const empty = await createSqlSandboxStore(db).insert({
      id: crypto.randomUUID(),
      provider: "boat",
      providerSandboxId: "bx_empty",
      goldenId: golden,
      orgId: org,
      ownerId: user,
      visibility: "private",
      harness: "codex",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
      status: "ready",
    });
    await replica().beforeResume(provider, empty.providerSandboxId, actor);
    expect(
      (
        await db.query<{ mcp_generation: number }>("select mcp_generation from public.sandboxes where id=$1", [
          empty.id,
        ])
      ).rows[0]?.mcp_generation,
    ).toBe(1);
  } finally {
    await service?.close();
    await Promise.all(servers.map((server) => server.close()));
    await db.close();
    await rm(home, { recursive: true, force: true });
  }
});
