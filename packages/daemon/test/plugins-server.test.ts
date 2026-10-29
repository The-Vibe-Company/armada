import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ServerMessage, serverMessageSchema, PROTOCOL_VERSION as version } from "@armada/protocol";
import { WebSocket } from "ws";
import { bootDaemon } from "../src/boot.ts";
import { Keychain } from "../src/keychain.ts";
import type { PluginCatalogEntry } from "../src/plugins/catalog.ts";
import { startServer } from "../src/server/index.ts";
import { FakeKeychain } from "./support/keychain.ts";

// The Plugins screen's side of the daemon (THE-2019), over a synthetic catalog
// booted as armadad boots it, and the app configuration in a temporary file.

const lamps = {
  id: "lamps",
  version: "1.0.0",
  pluginApi: "^0.1.0",
  enabledByDefault: true,
  description: "Reads the harbour's lamps",
  contributions: {
    tracker: {
      lamps: {
        description: "The lamp log",
        config: {
          type: "object",
          required: ["team"],
          properties: { team: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
        secrets: ["LAMP_TOKEN"],
      },
    },
  },
};
const quiet = { ...lamps, id: "quiet", enabledByDefault: false, contributions: {} };
const catalog: PluginCatalogEntry[] = [lamps, quiet].map((manifest) => ({
  id: manifest.id,
  manifest,
  load: async () => ({
    activate(ctx) {
      if (manifest.id === "lamps") ctx.register.tracker("lamps", { read: async () => {}, write: async () => {} });
    },
  }),
}));

async function fixture(
  run: (f: { dir: string; configPath: string; boot: () => ReturnType<typeof bootDaemon> }) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "armada-plugin-screen-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ theme: "night", plugins: [{ id: "lamps", config: { tracker: { lamps: { team: "EX" } } } }] }),
  );
  const silent = { info() {}, error() {} };
  try {
    await run({
      dir,
      configPath,
      boot: () =>
        bootDaemon({ databasePath: ":memory:", configPath, catalog, secrets: { get: async () => null }, log: silent }),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function connect(url: string) {
  const ws = new WebSocket(url);
  const frames: string[] = [];
  /** Every raw frame received, kept: the queue above is drained as the test reads it. */
  const seen: string[] = [];
  let wake: (() => void) | undefined;
  ws.on("message", (data) => {
    frames.push(String(data));
    seen.push(String(data));
    wake?.();
  });
  await once(ws, "open");
  let n = 0;
  return {
    seen,
    async ask(body: Record<string, unknown>): Promise<ServerMessage> {
      ws.send(JSON.stringify({ version, id: `r${++n}`, ...body }));
      if (!frames.length)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      wake = undefined;
      return serverMessageSchema.parse(JSON.parse(frames.shift() as string));
    },
    close: () => ws.close(),
  };
}

const plugin = (message: ServerMessage, id: string) => {
  assert.equal(message.type, "plugins.result", JSON.stringify(message));
  return message.type === "plugins.result" ? message.plugins.find((p) => p.id === id) : undefined;
};
const saved = (configPath: string) => JSON.parse(readFileSync(configPath, "utf8"));

test("the Plugins screen lists the catalog, saves switches and configs, keeps secrets and asks for a restart", async () =>
  fixture(async ({ configPath, boot }) => {
    const daemon = await boot();
    const backend = new FakeKeychain();
    let restarts = 0;
    const server = await startServer({
      store: daemon.store,
      projects: [],
      plugins: { configPath, catalog: daemon.catalog, boot: daemon, keychain: new Keychain(backend) },
      restart: () => {
        restarts += 1;
      },
    });
    const client = await connect(server.wsUrl);
    try {
      const listed = await client.ask({ type: "plugins.list" });
      assert.equal(listed.type === "plugins.result" && listed.restartable, true);
      assert.deepEqual(plugin(listed, "lamps"), {
        id: "lamps",
        version: "1.0.0",
        description: "Reads the harbour's lamps",
        enabled: true,
        loaded: true,
        restartRequired: false,
        contributions: [
          {
            seam: "tracker",
            kind: "lamps",
            description: "The lamp log",
            schema: lamps.contributions.tracker.lamps.config,
            config: { team: "EX" },
            secrets: [{ name: "LAMP_TOKEN", set: false }],
          },
        ],
      });
      assert.equal(plugin(listed, "quiet")?.enabled, false);
      assert.equal(plugin(listed, "quiet")?.loaded, false);

      // A switch is saved at once and applies at the next boot; switching back needs no restart.
      assert.deepEqual(plugin(await client.ask({ type: "plugins.disable", plugin: "lamps" }), "lamps"), {
        ...plugin(listed, "lamps"),
        enabled: false,
        restartRequired: true,
      });
      assert.equal(saved(configPath).plugins[0].enabled, false);
      assert.equal(
        plugin(await client.ask({ type: "plugins.enable", plugin: "lamps" }), "lamps")?.restartRequired,
        false,
      );

      // A config the contribution's schema refuses is not saved; a valid one is, beside the other settings.
      const refused = await client.ask({
        type: "plugins.configure",
        plugin: "lamps",
        seam: "tracker",
        kind: "lamps",
        config: { team: "" },
      });
      assert.deepEqual(refused.type === "error" && [refused.code, refused.message], [
        "invalid-message",
        "config tracker.lamps: config/team must NOT have fewer than 1 characters",
      ]);
      assert.deepEqual(saved(configPath).plugins[0].config, { tracker: { lamps: { team: "EX" } } });
      const configured = plugin(
        await client.ask({
          type: "plugins.configure",
          plugin: "lamps",
          seam: "tracker",
          kind: "lamps",
          config: { team: "OPS" },
        }),
        "lamps",
      );
      assert.deepEqual([configured?.contributions[0]?.config, configured?.restartRequired], [{ team: "OPS" }, true]);
      assert.deepEqual(saved(configPath), {
        theme: "night",
        plugins: [{ id: "lamps", enabled: true, config: { tracker: { lamps: { team: "OPS" } } } }],
      });
      const missing = await client.ask({
        type: "plugins.configure",
        plugin: "lamps",
        seam: "forge",
        kind: "lamps",
        config: {},
      });
      assert.deepEqual(missing.type === "error" && missing.code, "not-found");

      // Only a declared secret is kept, in the plugins' keychain service; its value never comes back.
      const value = randomBytes(16).toString("hex");
      const undeclared = await client.ask({ type: "plugins.secret", plugin: "lamps", name: "OTHER", value });
      assert.deepEqual(undeclared.type === "error" && undeclared.code, "not-found");
      assert.equal(backend.entries.size, 0);
      const kept = plugin(
        await client.ask({ type: "plugins.secret", plugin: "lamps", name: "LAMP_TOKEN", value }),
        "lamps",
      );
      assert.deepEqual(kept?.contributions[0]?.secrets, [{ name: "LAMP_TOKEN", set: true }]);
      assert.equal(await backend.read("armada.plugins", "LAMP_TOKEN"), value);

      const unknown = await client.ask({ type: "plugins.enable", plugin: "nowhere" });
      assert.deepEqual(unknown.type === "error" && unknown.code, "not-found");

      // A restart is answered first, then asked of the host.
      assert.deepEqual((await client.ask({ type: "daemon.restart" })).type, "daemon.restarting");
      assert.equal(restarts, 1);
      assert.equal(client.seen.length, 10);
      for (const frame of client.seen) assert.ok(!frame.includes(value));
    } finally {
      client.close();
      await server.close();
      daemon.close();
    }

    // The next boot loads what was saved: nothing left to restart for.
    const again = await boot();
    const next = await startServer({
      store: again.store,
      projects: [],
      plugins: { configPath, catalog: again.catalog, boot: again, keychain: new Keychain(new FakeKeychain()) },
    });
    const reconnected = await connect(next.wsUrl);
    try {
      const listed = await reconnected.ask({ type: "plugins.list" });
      assert.deepEqual(
        [
          plugin(listed, "lamps")?.loaded,
          plugin(listed, "lamps")?.restartRequired,
          listed.type === "plugins.result" && listed.restartable,
        ],
        [true, false, false],
      );
      const refused = await reconnected.ask({ type: "daemon.restart" });
      assert.deepEqual(refused.type === "error" && refused.code, "not-found");
    } finally {
      reconnected.close();
      await next.close();
      again.close();
    }
  }));

test("a daemon without a plugin host answers plugin requests with not-found", async () =>
  fixture(async ({ boot }) => {
    const daemon = await boot();
    const server = await startServer({ store: daemon.store, projects: [] });
    const client = await connect(server.wsUrl);
    try {
      const answer = await client.ask({ type: "plugins.list" });
      assert.deepEqual(answer.type === "error" && [answer.code, answer.message], [
        "not-found",
        "This daemon has no plugin catalog",
      ]);
    } finally {
      client.close();
      await server.close();
      daemon.close();
    }
  }));
