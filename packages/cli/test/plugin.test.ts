import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bootDaemon } from "@armada/daemon";
import type { PluginCatalogEntry } from "@armada/daemon/plugins/catalog";
import { updateAppConfig } from "@armada/daemon/plugins/config";
import { type Io, run } from "../src/cli.ts";

test("plugin list shows the boot catalog and switches preserve config until restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "armada-plugin-list-"));
  const configPath = join(dir, "config.json");
  try {
    const catalog: PluginCatalogEntry[] = [];
    for (const [id, pluginApi, enabledByDefault] of [
      ["working", "^0.1.0", true],
      ["disabled", "^0.1.0", false],
      ["future", ">=2.0.0", true],
    ] as const) {
      const path = join(dir, id);
      await mkdir(path);
      await writeFile(join(path, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(
        join(path, "index.js"),
        id === "disabled"
          ? "throw new Error('disabled must not import');"
          : "export function activate(ctx) { ctx.register.model('test', { create: () => ({}) }); }",
      );
      catalog.push({
        id,
        manifest: {
          id,
          version: "1.0.0",
          pluginApi,
          enabledByDefault,
          description: "A fixture model",
          contributions: { model: { test: { config: { type: "object" }, secrets: [] } } },
        },
        load: () => import(pathToFileURL(join(path, "index.js")).href),
      });
    }
    await updateAppConfig(configPath, () => ({
      theme: "dark",
      plugins: [{ id: "working", config: { model: { test: { preset: "fast" } } } }],
    }));
    const options = {
      databasePath: ":memory:",
      configPath,
      catalog,
      secrets: { get: async () => null },
      log: { info() {}, error() {} },
    };
    const daemon = await bootDaemon(options);
    let out = "";
    let err = "";
    const io: Io = {
      cwd: dir,
      env: { ARMADA_APP_CONFIG: configPath },
      readFile: async (path) => readFile(path, "utf8").catch(() => null),
      updateAppConfig,
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
      ghToken: () => null,
    };
    try {
      const results = await Promise.all([
        run(["plugin", "disable", "working"], io),
        run(["plugin", "enable", "disabled"], io),
      ]);
      expect(results).toEqual([0, 0]);
      const concurrent = JSON.parse(await readFile(configPath, "utf8"));
      expect(concurrent.plugins.find((p: { id: string }) => p.id === "working")?.enabled).toBe(false);
      expect(concurrent.plugins.find((p: { id: string }) => p.id === "disabled")?.enabled).toBe(true);
      await updateAppConfig(configPath, () => ({
        theme: "dark",
        plugins: [{ id: "working", config: { model: { test: { preset: "fast" } } } }],
      }));
      out = "";
      expect(await run(["plugin", "list"], io)).toBe(0);
      expect(err).toBe("");
      expect(out.split("\n")).toEqual([
        "working@1.0.0 enabled, loaded",
        "  └─ model.test enabled, loaded",
        "disabled@1.0.0 disabled, not loaded",
        "  └─ model.test disabled, not loaded",
        "future@1.0.0 enabled, refused: pluginApi >=2.0.0 excludes daemon Plugin API 0.1.0",
        "  └─ model.test enabled, refused: pluginApi >=2.0.0 excludes daemon Plugin API 0.1.0",
        "",
      ]);
      out = "";
      expect(await run(["plugin", "disable", "working"], io)).toBe(0);
      expect(out).toContain("Restart the daemon to apply");
      expect(daemon.registry.get("model", "test")).toBeDefined();
      const config = JSON.parse(await readFile(configPath, "utf8"));
      expect(config).toEqual({
        theme: "dark",
        plugins: [{ id: "working", enabled: false, config: { model: { test: { preset: "fast" } } } }],
      });
      out = "";
      expect(await run(["plugin", "list", "--json"], io)).toBe(0);
      expect(JSON.parse(out)[0]).toMatchObject({ enabled: false, loaded: true, restartRequired: true });
    } finally {
      daemon.close();
    }
    const restarted = await bootDaemon(options);
    try {
      expect(restarted.registry.get("model", "test")).toBeUndefined();
    } finally {
      restarted.close();
    }
    out = "";
    expect(await run(["plugin", "enable", "working"], io)).toBe(0);
    expect(out).toContain("enabled. Restart the daemon");
    expect(await run(["plugin", "enable", "absent"], io)).toBe(2);
    expect(await run(["plugin", "add"], io)).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bundled catalog can be listed and disabled before the first daemon boot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "armada-plugin-before-boot-"));
  try {
    const path = join(dir, "nested", "config.json");
    let out = "";
    const io: Io = {
      cwd: dir,
      env: { ARMADA_APP_CONFIG: path },
      readFile: async (path) => readFile(path, "utf8").catch(() => null),
      updateAppConfig,
      stdout: (s) => {
        out += s;
      },
      stderr() {},
      ghToken: () => null,
    };
    expect(await run(["plugin", "list"], io)).toBe(0);
    expect(out).toContain("hello@0.1.0 enabled, not loaded (restart required)");
    expect(await run(["plugin", "disable", "hello"], io)).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8")).plugins[0].enabled).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
