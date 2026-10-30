import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { bootDaemon } from "../src/boot.ts";

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "armada-plugins-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const manifest = (id: string, pluginApi = "^0.2.0") => ({
  id,
  version: "1.2.3",
  pluginApi,
  enabledByDefault: true,
  description: "A test provider",
  contributions: {
    tracker: {
      tickets: {
        config: {
          type: "object",
          required: ["team"],
          properties: { team: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
        secrets: ["LINEAR_TOKEN"],
      },
    },
  },
});
async function plugin(dir: string, id: string, data: unknown, source: string, standalone = false) {
  const path = join(dir, id);
  await mkdir(path);
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({ type: "module", main: "index.js", ...(standalone ? {} : { armada: data }) }),
  );
  if (standalone) await writeFile(join(path, "armada-plugin.json"), JSON.stringify(data));
  await writeFile(join(path, "index.js"), source);
  return {
    id,
    manifest: data,
    load: () => import(pathToFileURL(join(path, "index.js")).href),
    config: { tracker: { tickets: { team: "orchard" } } },
  };
}

test("daemon boot loads a temporary catalog once, exposes providers/events and refuses API mismatch before import", async () =>
  fixture(async (dir) => {
    const good = await plugin(
      dir,
      "good",
      manifest("good"),
      `
    export async function activate(ctx) {
      const secret = await ctx.secrets.get('LINEAR_TOKEN');
      let denied = false;
      try { await ctx.secrets.get('UNDECLARED'); } catch { denied = true; }
      await ctx.events.append({project:'orchard', kind:'hold.opened', at:'2030-01-01T00:00:00Z', actor:'good', payload:{id:'plugin',reason:ctx.config.tracker.tickets.team}});
      ctx.register.tracker('tickets', { read: async () => {
        const events = await ctx.events.read('orchard', 0);
        const fleet = await ctx.events.fold('orchard');
        await ctx.events.append({project:'orchard',kind:'coordinator.checkpoint',at:'2030-01-01T00:00:00Z',actor:'good',payload:{checkpoint:{secret,denied,count:events.length,reason:fleet.projects.orchard.holds[0].reason}}});
      }, write: async () => {} });
    }
  `,
    );
    const bad = await plugin(
      dir,
      "future",
      manifest("future", ">=2.0.0"),
      "throw new Error('must not import incompatible plugin');",
      true,
    );
    const disabled = await plugin(
      dir,
      "disabled",
      { ...manifest("disabled"), enabledByDefault: false },
      "throw new Error('must not import disabled plugin');",
    );
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ plugins: [good, bad].map(({ id, config }) => ({ id, config })) }));
    const lines: string[] = [];
    const reads: string[] = [];
    const daemon = await bootDaemon({
      databasePath: join(dir, "events.sqlite"),
      catalog: [good, disabled, bad],
      configPath,
      secrets: {
        get: async (name) => {
          reads.push(name);
          return "test-secret";
        },
      },
      log: { info: (line) => lines.push(line), error: (line) => lines.push(line) },
    });
    try {
      assert.deepEqual(
        daemon.plugins.map((p) => [p.id, p.version, p.loaded]),
        [
          ["good", "1.2.3", true],
          ["disabled", "1.2.3", false],
          ["future", "1.2.3", false],
        ],
      );
      assert.match(lines.join("\n"), /future.*>=2\.0\.0.*0\.2\.0/);
      assert.equal(lines.length, 1);
      const provider = daemon.registry.get("tracker", "tickets");
      assert.ok(provider);
      await provider.read({ project: "orchard" });
      const checkpoint = daemon.store.readSince(1, "orchard")[0];
      assert.deepEqual(checkpoint?.payload, {
        checkpoint: { secret: "test-secret", denied: true, count: 1, reason: "orchard" },
      });
      assert.deepEqual(reads, ["LINEAR_TOKEN"]);
    } finally {
      daemon.close();
    }
  }));

test("invalid manifest, config and activation leave no partial registrations and preserve schema messages", async () =>
  fixture(async (dir) => {
    const invalid = await plugin(
      dir,
      "invalid",
      { ...manifest("invalid"), description: 12 },
      "throw new Error('must not import invalid manifest');",
    );
    const config = await plugin(
      dir,
      "config",
      manifest("config"),
      "throw new Error('must not import invalid config');",
    );
    config.config.tracker.tickets.team = "";
    const broken = await plugin(
      dir,
      "broken",
      manifest("broken"),
      `export function activate(ctx) { ctx.register.tracker('tickets', {read:async()=>{},write:async()=>{}}); throw new Error('activation failed'); }`,
    );
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ plugins: [invalid, config, broken].map(({ id, config }) => ({ id, config })) }),
    );
    const daemon = await bootDaemon({
      databasePath: ":memory:",
      catalog: [invalid, config, broken],
      configPath: join(dir, "config.json"),
      log: { info() {}, error() {} },
      secrets: { get: async () => null },
    });
    try {
      assert.equal(daemon.registry.get("tracker", "tickets"), undefined);
      assert.equal(
        daemon.plugins.every((p) => !p.loaded),
        true,
      );
      assert.match(daemon.plugins[0]?.error ?? "", /description.*expected string/);
      assert.match(daemon.plugins[1]?.error ?? "", /team.*fewer than 1 characters|shorter than 1 characters/);
      assert.match(daemon.plugins[2]?.error ?? "", /activation failed/);
    } finally {
      daemon.close();
    }
  }));

test("missing app config boots default reader providers without reader credential lookup", async () =>
  fixture(async (dir) => {
    const daemon = await bootDaemon({
      databasePath: ":memory:",
      configPath: join(dir, "missing.json"),
      log: { info() {}, error() {} },
      secrets: {
        get: async (name) => {
          assert.ok(
            name !== "LINEAR_API_KEY" && name !== "GITHUB_TOKEN",
            "reader activation must not look up credentials",
          );
          return null;
        },
      },
    });
    try {
      assert.equal(daemon.plugins.find((p) => p.id === "hello")?.loaded, true);
      assert.deepEqual(
        daemon.plugins.filter((p) => p.enabled && !p.loaded),
        [],
      );
      assert.ok(daemon.registry.get("tracker", "linear"));
      assert.ok(daemon.registry.get("forge", "github"));
    } finally {
      daemon.close();
    }
  }));

test("registration ownership and lifecycle reject undeclared, missing and colliding providers", async () =>
  fixture(async (dir) => {
    const cases = [
      ["undeclared", "ctx.register.model('other', {create:()=>({})});", /undeclared contribution model.other/],
      ["missing", "", /missing registration tracker.tickets/],
      ["owner", "ctx.register.tracker('tickets', {read:async()=>{},write:async()=>{}});", null],
      [
        "collision",
        "ctx.register.tracker('tickets', {read:async()=>{},write:async()=>{}});",
        /duplicate contribution tracker.tickets/,
      ],
    ] as const;
    const entries = [];
    for (const [id, body] of cases)
      entries.push(await plugin(dir, id, manifest(id), `export function activate(ctx) { ${body} }`));
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ plugins: entries.map(({ id, config }) => ({ id, config })) }),
    );
    const daemon = await bootDaemon({
      databasePath: ":memory:",
      catalog: entries,
      configPath: join(dir, "config.json"),
      log: { info() {}, error() {} },
      secrets: { get: async () => null },
    });
    try {
      for (const [index, [, , error]] of cases.entries()) {
        if (error) assert.match(daemon.plugins[index]?.error ?? "", error);
        else assert.equal(daemon.plugins[index]?.loaded, true);
      }
      assert.ok(daemon.registry.get("tracker", "tickets"));
    } finally {
      daemon.close();
    }
  }));

test("invalid JSON Schema and explicit null config are refused before activation", async () =>
  fixture(async (dir) => {
    const invalidSchema = manifest("schema");
    invalidSchema.contributions.tracker.tickets.config.type = "invalid";
    const schema = await plugin(dir, "schema", invalidSchema, "throw new Error('must not activate');");
    const nullable = await plugin(dir, "null-config", manifest("null-config"), "throw new Error('must not activate');");
    const entries = [schema, { ...nullable, config: { tracker: { tickets: null } } }];
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ plugins: entries.map(({ id, config }) => ({ id, config })) }),
    );
    const daemon = await bootDaemon({
      databasePath: ":memory:",
      catalog: entries,
      configPath: join(dir, "config.json"),
      log: { info() {}, error() {} },
      secrets: { get: async () => null },
    });
    try {
      assert.match(daemon.plugins[0]?.error ?? "", /schema is invalid/);
      assert.match(daemon.plugins[1]?.error ?? "", /must be object/);
      assert.equal(daemon.registry.get("tracker", "tickets"), undefined);
    } finally {
      daemon.close();
    }
  }));

test("async config schemas are refused without importing the plugin or leaking a rejected validator", async () =>
  fixture(async (dir) => {
    const asyncManifest = {
      ...manifest("async-schema"),
      contributions: {
        model: { async: { config: { $async: true, type: "object", required: ["missing"] }, secrets: [] } },
      },
    };
    const entry = await plugin(
      dir,
      "async-schema",
      asyncManifest,
      "throw new Error('must not import invalid async config');",
    );
    const daemon = await bootDaemon({
      databasePath: ":memory:",
      configPath: join(dir, "config.json"),
      catalog: [entry],
      secrets: { get: async () => null },
      log: { info() {}, error() {} },
    });
    try {
      assert.match(daemon.plugins[0]?.error ?? "", /config schemas must be synchronous/);
    } finally {
      daemon.close();
    }
  }));

test("catalog providers isolate schema ids and close registration after boot", async () =>
  fixture(async (dir) => {
    const contribution = { config: { $id: "example-config", type: "object" }, secrets: [] };
    const provider = await plugin(
      dir,
      "lifecycle",
      {
        id: "lifecycle",
        version: "1.2.3",
        pluginApi: "^0.2.0",
        enabledByDefault: true,
        description: "Provider lifecycle",
        contributions: { model: { first: contribution, second: contribution } },
      },
      `export function activate(ctx) {
      ctx.register.model('first', {create:()=>ctx.register.model('first', {})});
      ctx.register.model('second', {create:()=> 'second'});
    }`,
    );
    const daemon = await bootDaemon({
      databasePath: ":memory:",
      configPath: join(dir, "config.json"),
      catalog: [provider],
      secrets: { get: async () => null },
      log: { info() {}, error() {} },
    });
    try {
      assert.equal(daemon.plugins[0]?.loaded, true);
      assert.throws(
        () => daemon.registry.get("model", "first")?.create("test"),
        /registration is only allowed during activate/,
      );
      assert.equal(daemon.registry.get("model", "second")?.create("test"), "second");
    } finally {
      daemon.close();
    }
  }));

test("the build catalog discovers all packages, prefers standalone manifests and defers imports", async () =>
  fixture(async (dir) => {
    const scripts = join(dir, "scripts");
    await mkdir(scripts);
    await copyFile(new URL("../../../scripts/plugin-catalog.ts", import.meta.url), join(scripts, "plugin-catalog.ts"));
    const outputDir = join(dir, "packages/daemon/src/plugins");
    await mkdir(outputDir, { recursive: true });
    const pluginsDir = join(dir, "packages/plugins");
    await mkdir(pluginsDir, { recursive: true });
    await plugin(
      pluginsDir,
      "first",
      { ...manifest("first"), contributions: {} },
      "export function activate() {}",
      true,
    );
    await writeFile(
      join(pluginsDir, "first", "package.json"),
      JSON.stringify({ type: "module", main: "index.js", armada: { invalid: "standalone manifest must win" } }),
    );
    await plugin(
      pluginsDir,
      "second",
      { ...manifest("second"), enabledByDefault: false },
      "throw new Error('catalog discovery must not import');",
    );
    execFileSync(process.execPath, [join(scripts, "plugin-catalog.ts")]);
    const { BUNDLED_PLUGINS: catalog } = await import(pathToFileURL(join(outputDir, "catalog.generated.ts")).href);
    assert.deepEqual(
      catalog.map((entry: { id: string }) => entry.id),
      ["first", "second"],
    );
    const daemon = await bootDaemon({
      databasePath: ":memory:",
      configPath: join(dir, "config.json"),
      catalog,
      secrets: { get: async () => null },
      log: { info() {}, error() {} },
    });
    try {
      assert.deepEqual(
        daemon.plugins.map((p) => [p.id, p.enabled, p.loaded]),
        [
          ["first", true, true],
          ["second", false, false],
        ],
      );
    } finally {
      daemon.close();
    }
  }));

test("armadad loads the bundled catalog before announcing server readiness", { timeout: 10000 }, async () =>
  fixture(async (dir) => {
    const configPath = join(dir, "config.json");
    const projects = join(dir, "projects.json");
    await writeFile(projects, JSON.stringify([{ id: "orchard", name: "Orchard", repository: "example/orchard" }]));
    const child = spawn(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => { throw new Error("offline fixture"); };')}`,
        new URL("../src/server/main.ts", import.meta.url).pathname,
        "--database",
        join(dir, "fleet.sqlite"),
        "--projects",
        projects,
      ],
      {
        env: {
          ...process.env,
          ARMADA_APP_CONFIG: configPath,
          XDG_CONFIG_HOME: dir,
          GITHUB_TOKEN: randomBytes(24).toString("hex"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    let output = "";
    child.stderr.resume();
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(new Error("armadad exited before readiness")));
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("\n")) resolve();
        });
      });
      assert.match(JSON.parse(output.trim()).wsUrl, /^ws:\/\/127\.0\.0\.1:/);
      const status = JSON.parse(await readFile(`${configPath}.plugins.json`, "utf8"));
      assert.equal(status.plugins.find((p: { id: string }) => p.id === "hello")?.loaded, true);
      assert.deepEqual(
        status.plugins.filter((p: { enabled: boolean; loaded: boolean }) => p.enabled && !p.loaded),
        [],
      );
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  }),
);
