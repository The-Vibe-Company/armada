import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ServerMessage, serverMessageSchema, PROTOCOL_VERSION as version } from "@armada/protocol";
import type { AuthEvent, Credential, Provider } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { WebSocket } from "ws";
import { Keychain } from "../src/keychain.ts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { ModelRegistry, wireContext } from "../src/models/registry.ts";
import { fileKeychain } from "../src/secrets/file.ts";
import { startServer } from "../src/server/index.ts";
import { modelEnvironment } from "../src/server/models.ts";
import { EventStore } from "../src/store.ts";

async function client(url: string) {
  const ws = new WebSocket(url);
  const frames: ServerMessage[] = [];
  let wake = () => {};
  ws.on("message", (raw) => {
    frames.push(serverMessageSchema.parse(JSON.parse(String(raw))));
    wake();
  });
  await once(ws, "open");
  return {
    ws,
    frames,
    send: (body: Record<string, unknown>) => ws.send(JSON.stringify({ version, ...body })),
    async next(predicate: (frame: ServerMessage) => boolean): Promise<ServerMessage> {
      for (;;) {
        const frame = frames.find(predicate);
        if (frame) return frame;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

test("pi's catalog exposes built-in login methods and environment availability without credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "armada-pi-catalog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const token = randomBytes(24).toString("hex");
  const registry = new ModelRegistry({ keychain: new Keychain(fileKeychain(dir)), env: { OPENAI_API_KEY: token } });
  const catalog = await registry.catalog();
  assert.equal(catalog.providers[0]?.id, "openai-codex");
  for (const id of ["openai-codex", "anthropic"]) {
    assert.equal(catalog.providers.find((p) => p.id === id)?.auth.oauth, true);
  }
  const openai = catalog.providers.find((p) => p.id === "openai");
  assert.equal(openai?.auth.apiKey, true);
  assert.equal(openai?.status, "env");
  assert.ok(openai?.auth.envVars.includes("OPENAI_API_KEY"));
  assert.ok(openai.models.length > 0);
  assert.equal(JSON.stringify(catalog).includes(token), false);
});

test("model auth streams connection-owned prompts, broadcasts safe catalogs, and cancels without storing an answer", {
  timeout: 10000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "armada-pi-wire-"));
  const token = randomBytes(24).toString("hex");
  const output: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => output.push(args));
  t.mock.method(console, "log", (...args: unknown[]) => output.push(args));
  const chain = new Keychain(fileKeychain(join(dir, "credentials")));
  const faux = fauxProvider({ provider: "orchard", models: [{ id: "small" }] });
  let fail = false;
  const registry = new ModelRegistry({
    keychain: chain,
    env: {},
    providers: [
      {
        ...faux.provider,
        auth: {
          oauth: {
            name: "Orchard",
            async login(interaction) {
              if (fail) throw new Error(token);
              interaction.notify({ type: "auth_url", url: "https://example.test/authorize" });
              const answer = await interaction.prompt({ type: "secret", message: "Orchard code" });
              return { type: "oauth", access: answer, refresh: answer, expires: 4102444800000 };
            },
            refresh: async (credential) => credential,
            toAuth: async (credential) => ({ apiKey: credential.access }),
          },
        },
      },
    ],
  });
  const store = new EventStore(":memory:");
  const server = await startServer({ projects: [], store, keychain: chain, modelRegistry: registry });
  const owner = await client(server.wsUrl);
  const other = await client(server.wsUrl);
  t.after(async () => {
    owner.ws.terminate();
    other.ws.terminate();
    await server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  other.send({ type: "models.providers", id: "other-catalog" });
  await other.next((f) => f.type === "models.catalog");
  owner.send({ type: "models.select", id: "unconfigured", provider: "orchard", model: "small" });
  assert.equal((await owner.next((f) => "id" in f && f.id === "unconfigured")).type, "error");
  owner.send({ type: "models.login", id: "login", provider: "orchard", authType: "oauth" });
  const prompt = await owner.next((f) => f.type === "auth.prompt" && f.flow === "login");
  assert.ok(prompt.type === "auth.prompt");
  assert.equal(prompt.promptType, "secret");
  assert.ok(owner.frames.some((f) => f.type === "auth.event" && f.event.type === "auth_url"));
  other.send({ type: "models.login", id: "competing", provider: "orchard", authType: "oauth" });
  assert.equal((await other.next((f) => "id" in f && f.id === "competing")).type, "error");
  other.send({ type: "auth.answer", flow: "login", id: prompt.id, value: token });
  assert.equal((await other.next((f) => "id" in f && f.id === prompt.id)).type, "error");
  assert.equal(await chain.read("pi", "orchard"), null);
  owner.send({ type: "auth.answer", flow: "login", id: prompt.id, value: token });
  const completed = await owner.next((f) => f.type === "models.catalog" && f.id === "login");
  assert.ok(completed.type === "models.catalog");
  assert.equal(completed.providers[0]?.status, "signed-in");
  assert.equal(
    (await other.next((f) => f.type === "models.catalog" && f.providers[0]?.status === "signed-in")).type,
    "models.catalog",
  );
  assert.equal(JSON.parse((await chain.read("pi", "orchard")) ?? "null").access === token, true);
  owner.send({ type: "models.logout", id: "logout", provider: "orchard" });
  await owner.next((f) => f.type === "models.catalog" && f.id === "logout");
  owner.send({ type: "models.login", id: "cancelled", provider: "orchard", authType: "oauth" });
  await owner.next((f) => f.type === "auth.prompt" && f.flow === "cancelled");
  owner.send({ type: "auth.cancel", id: "cancel", flow: "cancelled" });
  await owner.next((f) => f.type === "error" && f.id === "cancelled");
  await owner.next((f) => f.type === "models.catalog" && f.id === "cancel");
  assert.equal(await chain.read("pi", "orchard"), null);
  owner.send({ type: "models.login", id: "logout-race", provider: "orchard", authType: "oauth" });
  const revoked = await owner.next((f) => f.type === "auth.prompt" && f.flow === "logout-race");
  assert.ok(revoked.type === "auth.prompt");
  other.send({ type: "models.logout", id: "revoke-pending-login", provider: "orchard" });
  await other.next((f) => f.type === "models.catalog" && f.id === "revoke-pending-login");
  owner.send({ type: "auth.answer", flow: "logout-race", id: revoked.id, value: token });
  await owner.next((f) => f.type === "error" && f.id === revoked.id);
  assert.equal(await chain.read("pi", "orchard"), null);
  fail = true;
  owner.send({ type: "models.login", id: "failed", provider: "orchard", authType: "oauth" });
  await owner.next((f) => f.type === "error" && f.id === "failed");
  fail = false;
  owner.send({ type: "models.login", id: "disconnected", provider: "orchard", authType: "oauth" });
  await owner.next((f) => f.type === "auth.prompt" && f.flow === "disconnected");
  owner.ws.close();
  await once(owner.ws, "close");
  other.send({ type: "models.login", id: "after-drop", provider: "orchard", authType: "oauth" });
  await other.next((f) => f.type === "auth.prompt" && f.flow === "after-drop");
  other.send({ type: "auth.cancel", id: "cancel-after-drop", flow: "after-drop" });
  await other.next((f) => f.type === "error" && f.id === "after-drop");
  assert.equal(await chain.read("pi", "orchard"), null);
  assert.equal(JSON.stringify([owner.frames, other.frames, output, store.readSince(0)]).includes(token), false);
});

test("credentials.set for a pi provider writes an api_key and pushes its status without changing selection", {
  timeout: 10000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "armada-pi-key-"));
  const chain = new Keychain(fileKeychain(join(dir, "credentials")));
  const registry = new ModelRegistry({ keychain: chain, env: {} });
  const store = new EventStore(":memory:");
  const server = await startServer({ projects: [], store, keychain: chain, modelRegistry: registry });
  const owner = await client(server.wsUrl);
  t.after(async () => {
    owner.ws.terminate();
    await server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const key = randomBytes(24).toString("hex");
  owner.send({ type: "credentials.set", id: "key", provider: "openai", key });
  await owner.next((f) => f.type === "credentials.result" && f.id === "key");
  const catalog = await owner.next((f) => f.type === "models.catalog" && f.id === "key");
  assert.ok(catalog.type === "models.catalog");
  assert.equal(catalog.providers.find((p) => p.id === "openai")?.status, "key-set");
  const stored = JSON.parse((await chain.read("pi", "openai")) ?? "null");
  assert.equal(stored.type, "api_key");
  assert.equal(stored.key === key, true);
  assert.equal(catalog.selected, null);
  assert.equal(JSON.stringify(owner.frames).includes(key), false);
  const pluginKey = randomBytes(24).toString("hex");
  owner.send({
    type: "credentials.set",
    id: "plugin-key",
    provider: "anthropic",
    key: pluginKey,
    config: { model: "custom-claude" },
  });
  await owner.next((f) => f.type === "credentials.result" && f.id === "plugin-key");
  const plugin = await chain.coordinator();
  assert.equal(plugin?.key === pluginKey, true);
  assert.equal(plugin?.config?.model, "custom-claude");
  assert.equal(await chain.read("pi", "anthropic"), null);
  owner.send({ type: "credentials.set", id: "pi-anthropic", provider: "anthropic", target: "pi", key });
  await owner.next((f) => f.type === "credentials.result" && f.id === "pi-anthropic");
  assert.equal(JSON.parse((await chain.read("pi", "anthropic")) ?? "null").key === key, true);
  assert.equal((await chain.coordinator())?.key === pluginKey, true);
  owner.send({ type: "credentials.set", id: "unknown-pi", provider: "custom-endpoint", target: "pi", key });
  await owner.next((f) => f.type === "error" && f.id === "unknown-pi");
  assert.equal((await chain.coordinator())?.key === pluginKey, true);
  owner.send({
    type: "credentials.set",
    version: { major: 1, minor: 8 },
    id: "legacy-key",
    provider: "anthropic",
    key: pluginKey,
  });
  await owner.next((f) => f.type === "credentials.result" && f.id === "legacy-key");
  owner.send({ type: "models.providers", id: "after-legacy" });
  await owner.next((f) => f.type === "models.catalog" && f.id === "after-legacy");
  assert.equal(
    owner.frames.some((f) => f.type === "models.catalog" && f.id === "legacy-key"),
    false,
  );
});

test("pi login, refresh and logout persist in the keychain; selection requires configured auth", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "armada-pi-auth-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const token = randomBytes(24).toString("hex");
  const refreshed = randomBytes(24).toString("hex");
  const chain = new Keychain(fileKeychain(join(dir, "credentials")));
  const faux = fauxProvider({ provider: "orchard", models: [{ id: "small" }] });
  let refreshes = 0;
  const provider: Provider = {
    ...faux.provider,
    auth: {
      oauth: {
        name: "Orchard",
        async login(interaction) {
          interaction.notify({
            type: "device_code",
            userCode: "ORCHARD",
            verificationUri: "https://example.test/device",
          });
          return { type: "oauth", access: token, refresh: token, expires: 0 };
        },
        async refresh(credential) {
          refreshes++;
          return { ...credential, access: refreshed, expires: Date.now() + 3600_000 };
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
  };
  const registry = new ModelRegistry({ keychain: chain, providers: [provider], env: {} });
  assert.equal((await registry.catalog()).providers[0]?.status, "unconfigured");
  await assert.rejects(registry.select({ provider: "orchard", model: "small" }), /configured/);
  const events: AuthEvent[] = [];
  await registry.models.login("orchard", "oauth", {
    prompt: async () => {
      throw new Error("Unexpected prompt");
    },
    notify: (event) => events.push(event),
  });
  assert.equal(events[0]?.type, "device_code");
  assert.equal((JSON.parse((await chain.read("pi", "orchard")) ?? "null") as Credential).type, "oauth");
  assert.equal((await registry.catalog()).providers[0]?.status, "signed-in");
  const secondRegistry = new ModelRegistry({
    keychain: new Keychain(fileKeychain(join(dir, "credentials"))),
    providers: [provider],
    env: {},
  });
  await Promise.all([registry.models.getAuth("orchard"), secondRegistry.models.getAuth("orchard")]);
  assert.equal(refreshes, 1);
  assert.equal(JSON.parse((await chain.read("pi", "orchard")) ?? "null").access === refreshed, true);
  const pluginKey = randomBytes(24).toString("hex");
  const pluginConfig = { baseURL: "https://example.test/v1", model: "custom" };
  await chain.setCoordinator("openai-compatible", pluginKey, pluginConfig);
  await registry.select({ provider: "orchard", model: "small" });
  assert.deepEqual(await chain.coordinator(), { provider: "orchard", model: "small" });
  assert.deepEqual((await registry.catalog()).selected, { provider: "orchard", model: "small" });
  const reboot = await modelEnvironment({}, new Keychain(fileKeychain(join(dir, "credentials"))));
  assert.deepEqual(reboot.selected, { provider: "orchard", model: "small" });
  assert.equal((await reboot.secrets.get("ARMADA_MODEL_API_KEY")) === pluginKey, true);
  assert.equal(JSON.stringify(await registry.catalog()).includes(token), false);
  await registry.models.logout("orchard");
  assert.equal(await chain.read("pi", "orchard"), null);
  assert.equal((await registry.catalog()).providers[0]?.status, "unconfigured");
});

test("dotted tool names travel aliased on the wire and come back dotted to the harness (THE-2090)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "armada-pi-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "orchard", models: [{ id: "small" }] });
  const seen: { calls: string[]; results: string[] }[] = [];
  faux.setResponses([
    (context) => {
      seen.push({
        calls: context.messages.flatMap((m) =>
          m.role === "assistant" ? m.content.flatMap((p) => (p.type === "toolCall" ? [p.name] : [])) : [],
        ),
        results: context.messages.flatMap((m) => (m.role === "toolResult" ? [m.toolName] : [])),
      });
      return fauxAssistantMessage(fauxToolCall("fleet__status", {}, { id: "call-1" }), { stopReason: "toolUse" });
    },
  ]);
  const registry = new ModelRegistry({
    keychain: new Keychain(fileKeychain(join(dir, "credentials"))),
    providers: [faux.provider],
    env: {},
  });
  const model = registry.models.getModel("orchard", "small");
  assert.ok(model);
  const tools = [{ name: "fleet.status", description: "Read the fleet", parameters: Type.Object({}) }];
  assert.deepEqual(
    wireContext({ messages: [], tools }).tools?.map((tool) => tool.name),
    ["fleet__status"],
  );
  // The harness hands a normalized transcript: the tools live in its first system message.
  const transcript = wireContext(normalizeContext({ systemPrompt: "Coordinate.", messages: [], tools }));
  const first = transcript.messages[0];
  assert.ok(first && first.role === "system");
  assert.deepEqual(
    first.toolsAdded?.map((tool) => tool.name),
    ["fleet__status"],
  );
  const reply = await registry.models.complete(model, {
    tools,
    messages: [
      { role: "user", content: "status?", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-0", name: "fleet.status", arguments: {} }],
        api: "faux",
        provider: "orchard",
        model: "small",
        timestamp: 2,
        stopReason: "toolUse",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      {
        role: "toolResult",
        toolCallId: "call-0",
        toolName: "fleet.status",
        content: [{ type: "text", text: "{}" }],
        isError: false,
        timestamp: 3,
      },
    ],
  });
  assert.deepEqual(seen, [{ calls: ["fleet__status"], results: ["fleet__status"] }]);
  assert.equal(reply.stopReason, "toolUse");
  assert.deepEqual(
    reply.content.flatMap((p) => (p.type === "toolCall" ? [p.name] : [])),
    ["fleet.status"],
  );
});
