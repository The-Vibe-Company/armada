import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bootDaemon } from "../src/boot.ts";
import { Keychain } from "../src/keychain.ts";
import type { PluginCatalogEntry } from "../src/plugins/catalog.ts";
import { fileKeychain } from "../src/secrets/file.ts";
import { Providers } from "../src/server/providers.ts";

test("provider catalog orders agents first, respects switches, refreshes and never publishes secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "providers-"));
  const token = randomBytes(24).toString("hex");
  const email = "mira@example.test";
  const logs: string[] = [];
  const configPath = join(dir, "config.json");
  const keychain = new Keychain(fileKeychain(join(dir, "keys")));
  await keychain.write("plugin", "FAKE_TOKEN", token);
  let connected = false;
  const catalog: PluginCatalogEntry[] = ["tracker", "runtime"].map((seam) => ({
    id: seam === "runtime" ? "agent" : "tracker",
    manifest: {
      id: seam === "runtime" ? "agent" : "tracker",
      version: "1.0.0",
      pluginApi: "^0.2.0",
      enabledByDefault: true,
      description: "Synthetic provider",
      contributions: { [seam]: { sample: { config: { type: "object" }, secrets: ["FAKE_TOKEN"] } } },
    },
    load: async () => ({
      activate(ctx) {
        (ctx.register[seam as "tracker"] as Function)("sample", {
          read: async () => {},
          write: async () => {},
          status: async () => ({
            installed: true,
            version: "1.2.3",
            state: connected ? "connected" : "disconnected",
            detail: `Safe ${token} ${email}`,
            account: { label: "Mira", plan: `Plan ${token} ${email}` },
          }),
          connect: async () => {
            connected = true;
          },
          disconnect: async () => {
            connected = false;
          },
        });
      },
    }),
  }));
  const daemon = await bootDaemon({
    databasePath: ":memory:",
    configPath,
    catalog,
    secrets: { get: (name) => keychain.read("plugin", name) },
    log: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
  });
  let tick: (() => void) | undefined;
  const providers = new Providers(
    { configPath, catalog, boot: daemon, registry: daemon.registry, keychain },
    {
      schedule(run, ms) {
        assert.equal(ms, 300000);
        tick = run;
        return () => {
          tick = undefined;
        };
      },
    },
  );
  const messages: unknown[] = [];
  const unsubscribe = providers.subscribe((list) => messages.push(list));
  try {
    const first = await providers.refresh();
    assert.deepEqual(
      first.map((p) => p.seam),
      ["agent", "tracker"],
    );
    assert.equal(first[0]?.state, "disconnected");
    await providers.refresh();
    assert.equal(messages.length, 1, "unchanged polls do not push");
    await providers.connect("agent", { notify() {}, prompt: async () => "unused" });
    assert.equal(messages.length, 2);
    assert.equal((await providers.refresh())[0]?.state, "connected");
    await writeFile(configPath, JSON.stringify({ plugins: [{ id: "agent", enabled: false }] }));
    assert.equal((await providers.refresh())[0]?.enabled, false);
    await assert.rejects(providers.connect("agent", { notify() {}, prompt: async () => "" }), /Enable/);
    await providers.disconnect("tracker");
    await writeFile(configPath, JSON.stringify({ plugins: [{ id: "agent", enabled: true }] }));
    assert.equal((await providers.refresh())[0]?.state, "disconnected");
    assert.ok(tick);
    connected = true;
    tick();
    assert.equal(
      (await providers.refresh())[0]?.state,
      "connected",
      "the scheduled refresh observes external sign-in changes",
    );
    const raw = JSON.stringify({ messages, logs });
    assert.ok(!raw.includes(token));
    assert.ok(!raw.includes(email));
    assert.equal(daemon.store.sequence, 0, "connection changes are not fleet history");
  } finally {
    unsubscribe();
    providers.close();
    assert.equal(tick, undefined);
    daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider catalog and switch changes are pushed over the websocket to every capable client", async () => {
  const { once } = await import("node:events");
  const { WebSocket } = await import("ws");
  const { PROTOCOL_VERSION: version } = await import("@armada/protocol");
  const { startServer } = await import("../src/server/index.ts");
  const dir = await mkdtemp(join(tmpdir(), "providers-wire-"));
  const configPath = join(dir, "config.json");
  const keychain = new Keychain(fileKeychain(join(dir, "keys")));
  const token = randomBytes(24).toString("hex");
  const email = "mira@example.test";
  const logs: string[] = [];
  const secrets = {
    get: (name: string) => keychain.read("plugin", name),
    set: (name: string, value: string) => keychain.write("plugin", name, value),
    delete: (name: string) => keychain.remove("plugin", name),
  };
  const daemon = await bootDaemon({
    databasePath: ":memory:",
    configPath,
    catalog: [
      {
        id: "agent",
        manifest: {
          id: "agent",
          version: "1.0.0",
          pluginApi: "^0.2.0",
          enabledByDefault: true,
          description: "An agent",
          contributions: { runtime: { sample: { config: { type: "object" }, secrets: ["FAKE_TOKEN"] } } },
        },
        load: async () => ({
          activate(ctx) {
            ctx.register.runtime("sample", {
              status: async () => {
                const key = await ctx.secrets.get("FAKE_TOKEN");
                return {
                  installed: true,
                  state: key ? "connected" : "disconnected",
                  ...(key ? { account: { label: "Mira" }, detail: `${key} ${email}` } : {}),
                };
              },
              connect: async (interaction: import("@armada/plugin-api").AuthInteraction) => {
                interaction.notify({ type: "terminal", output: `api_key=${token} ${email}\n` });
                const answer = await interaction.prompt({ type: "secret", message: "Provider key" });
                if (answer !== token) throw new Error(`${token} ${email}`);
                await ctx.secrets.set?.("FAKE_TOKEN", answer);
              },
              disconnect: async () => {
                await ctx.secrets.delete?.("FAKE_TOKEN");
              },
            } as import("@armada/plugin-api").RuntimeProvider);
          },
        }),
      },
    ],
    secrets,
    log: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
  });
  const host = {
    configPath,
    catalog: daemon.catalog,
    boot: daemon,
    registry: daemon.registry,
    keychain,
    secrets,
  };
  let refreshCancelled = false;
  const providers = new Providers(host, {
    schedule() {
      return () => {
        refreshCancelled = true;
      };
    },
  });
  let modelAnswered = false;
  const modelRegistry = {
    models: {
      async login(_provider: string, _type: string, interaction: import("@armada/plugin-api").AuthInteraction) {
        await interaction.prompt({ type: "secret", message: "Model key" });
        modelAnswered = true;
      },
    },
    catalog: async () => ({ providers: [], selected: null }),
  } as unknown as import("../src/models/registry.ts").ModelRegistry;
  const server = await startServer({ store: daemon.store, projects: [], plugins: host, providers, modelRegistry });
  async function client() {
    const ws = new WebSocket(server.wsUrl);
    const queue: import("@armada/protocol").ServerMessage[] = [];
    const readers: ((value: import("@armada/protocol").ServerMessage) => void)[] = [];
    const seen: string[] = [];
    ws.on("message", (data) => {
      seen.push(String(data));
      const value = JSON.parse(String(data));
      const reader = readers.shift();
      if (reader) reader(value);
      else queue.push(value);
    });
    await once(ws, "open");
    return {
      ws,
      seen,
      send: (message: object) => ws.send(JSON.stringify({ version, ...message })),
      read: () =>
        queue.length
          ? Promise.resolve(queue.shift()!)
          : new Promise<import("@armada/protocol").ServerMessage>((resolve) => readers.push(resolve)),
    };
  }
  const first = await client();
  const second = await client();
  try {
    first.send({ type: "projects.list", id: "projects-one" });
    await first.read();
    second.send({ type: "projects.list", id: "projects-two" });
    await second.read();
    first.send({ type: "providers.list", id: "list" });
    assert.equal((await first.read()).type, "providers.catalog");
    const reply = await first.read();
    assert.equal(reply.type, "providers.catalog");
    if (reply.type === "providers.catalog") {
      assert.equal(reply.id, "list");
      assert.equal(reply.providers[0]?.state, "disconnected");
    }
    assert.equal((await second.read()).type, "providers.catalog");
    first.send({ type: "plugins.disable", plugin: "agent", id: "disable" });
    assert.equal((await first.read()).type, "plugins.result");
    const changed = await second.read();
    assert.equal(changed.type, "providers.catalog");
    if (changed.type === "providers.catalog") assert.equal(changed.providers[0]?.enabled, false);
    first.send({ type: "plugins.enable", plugin: "agent", id: "enable" });
    // Drain the first client's disable push before its enable answer.
    await first.read();
    assert.equal((await first.read()).type, "plugins.result");
    const enabled = await second.read();
    assert.equal(enabled.type, "providers.catalog");
    if (enabled.type === "providers.catalog") {
      assert.equal(enabled.providers[0]?.enabled, true);
      assert.equal(enabled.providers[0]?.state, "disconnected");
    }
    await first.read(); // enable push
    first.send({ type: "providers.connect", provider: "agent", id: "connect" });
    assert.equal((await first.read()).type, "auth.event");
    const prompt = await first.read();
    assert.equal(prompt.type, "auth.prompt");
    if (prompt.type !== "auth.prompt") throw new Error("Expected prompt");
    second.send({ type: "auth.answer", flow: "connect", id: prompt.id, value: token });
    assert.equal((await second.read()).type, "error", "another socket cannot answer");
    second.send({ type: "providers.connect", provider: "agent", id: "connect" });
    assert.equal((await second.read()).type, "error", "models and providers share the one login slot");
    first.send({ type: "providers.answer", id: prompt.id, value: token });
    const push = await second.read();
    assert.equal(push.type, "providers.catalog");
    if (push.type === "providers.catalog") assert.equal(push.providers[0]?.state, "connected");
    const own = [await first.read(), await first.read()];
    assert.ok(own.some((frame) => frame.type === "providers.catalog" && frame.id === "connect"));
    assert.equal(await keychain.read("plugin", "FAKE_TOKEN"), token);
    first.send({ type: "providers.disconnect", provider: "agent", id: "disconnect" });
    await first.read();
    await first.read();
    await second.read();
    assert.equal(await keychain.read("plugin", "FAKE_TOKEN"), null);
    first.send({ type: "providers.connect", provider: "agent", id: "cancelled-login" });
    await first.read();
    assert.equal((await first.read()).type, "auth.prompt");
    first.send({ type: "auth.cancel", flow: "cancelled-login", id: "cancel" });
    const cancelled = await first.read();
    assert.equal(cancelled.type, "error");
    const terminal = await first.read();
    assert.equal(terminal.type, "providers.catalog");
    assert.equal("id" in terminal && terminal.id, "cancel");
    first.send({ type: "models.login", provider: "synthetic", authType: "api_key", id: "model-flow" });
    const modelPrompt = await first.read();
    assert.equal(modelPrompt.type, "auth.prompt");
    if (modelPrompt.type !== "auth.prompt") throw new Error("Expected model prompt");
    first.send({
      type: "providers.answer",
      flow: "model-flow",
      promptId: modelPrompt.id,
      value: "wrong channel",
      id: "wrong-model-answer",
    });
    const refusedAnswer = await first.read();
    assert.equal(refusedAnswer.type, "error");
    assert.equal("id" in refusedAnswer && refusedAnswer.id, "wrong-model-answer");
    assert.equal(modelAnswered, false);
    for (const body of [
      { type: "providers.cancel", flow: "model-flow", id: "wrong-model-cancel" },
      { type: "providers.cancel", id: "wrong-implicit-cancel" },
    ]) {
      first.send(body);
      const refused = await first.read();
      assert.equal(refused.type, "error");
      assert.equal("id" in refused && refused.id, body.id);
      assert.equal(modelAnswered, false);
    }
    first.send({ type: "auth.answer", flow: "model-flow", id: modelPrompt.id, value: "owner answer" });
    const modelConnected = await first.read();
    assert.equal(modelConnected.type, "models.catalog");
    assert.equal("id" in modelConnected && modelConnected.id, "model-flow");
    assert.equal(modelAnswered, true);
    const messages = JSON.stringify({ first: first.seen, second: second.seen, logs });
    assert.ok(!messages.includes(token));
    assert.ok(!messages.includes(email));
    assert.equal(daemon.store.sequence, 0);
  } finally {
    first.ws.close();
    second.ws.close();
    await server.close();
    assert.equal(refreshCancelled, true, "server shutdown cancels provider refreshes");
    daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("closing a provider catalog during credential lookup starts no late status probes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "providers-close-"));
  const configPath = join(dir, "config.json");
  let probes = 0;
  let release: (value: string | null) => void = () => {};
  let started: () => void = () => {};
  const lookup = new Promise<void>((resolve) => {
    started = resolve;
  });
  const daemon = await bootDaemon({
    databasePath: ":memory:",
    configPath,
    catalog: [
      {
        id: "late",
        manifest: {
          id: "late",
          version: "1.0.0",
          pluginApi: "^0.2.0",
          enabledByDefault: true,
          description: "Late provider",
          contributions: { runtime: { late: { config: {}, secrets: ["LATE_KEY"] } } },
        },
        load: async () => ({
          activate(ctx) {
            ctx.register.runtime("late", {
              status: async () => {
                probes++;
                return new Promise(() => {});
              },
            } as import("@armada/plugin-api").RuntimeProvider);
          },
        }),
      },
    ],
    secrets: { get: async () => null },
    log: { info() {}, error() {} },
  });
  const providers = new Providers(
    {
      configPath,
      catalog: daemon.catalog,
      boot: daemon,
      registry: daemon.registry,
      keychain: {
        read: async () => {
          started();
          return new Promise<string | null>((resolve) => {
            release = resolve;
          });
        },
        write: async () => {},
      },
    },
    { schedule: () => () => {} },
  );
  try {
    const reading = providers.refresh();
    await lookup;
    providers.close();
    release(null);
    await reading;
    assert.equal(probes, 0);
  } finally {
    providers.close();
    daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});
