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

test("plugin test loads hello, reports a named tracker failure and preserves loader refusals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "armada-plugin-conformance-"));
  let out = "";
  let err = "";
  const io: Io = {
    cwd: process.cwd(),
    env: {},
    ghToken: () => null,
    readFile: async (path) => readFile(path, "utf8").catch(() => null),
    writeFile: async (path, text) => {
      await writeFile(path, text);
    },
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
  };
  try {
    expect(await run(["plugin", "test", "packages/plugins/hello", "--report", join(dir, "report.json")], io)).toBe(0);
    expect(out).toContain("0 checks: 0 passed, 0 failed");
    expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8"))).toMatchObject({
      plugin: "hello",
      passed: 0,
      failed: 0,
      checks: [],
    });
    const wrong = join(dir, "wrong");
    await mkdir(wrong);
    await writeFile(
      join(wrong, "package.json"),
      JSON.stringify({
        type: "module",
        main: "./index.mjs",
        armada: {
          id: "wrong",
          version: "1.0.0",
          pluginApi: "^0.1.0",
          enabledByDefault: false,
          description: "Deliberately wrong tracker",
          contributions: { tracker: { wrong: { config: true, secrets: [] } } },
        },
      }),
    );
    await writeFile(
      join(wrong, "index.mjs"),
      await readFile(new URL("./fixtures/plugin-test/wrong-tracker.mjs", import.meta.url), "utf8"),
    );
    await writeFile(
      join(wrong, "armada-plugin.test.json"),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the runner expands fixture placeholders
      JSON.stringify({ tracker: { wrong: { endpoint: "${endpoint}/tracker" } } }),
    );
    out = "";
    expect(await run(["plugin", "test", wrong], io)).toBe(1);
    expect(out).toContain("FAIL tracker.wrong.read-events");
    expect(out).toContain("read did not append the recorded ticket.seen payload");
    expect(out).toContain("failed");
    err = "";
    expect(await run(["plugin", "test", dir], io)).toBe(1);
    expect(err.trim()).toMatch(/^Plugin .+ refused:/);
    expect(err.trim().split("\n")).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("plugin test exercises recorded reads, writes, PTYs, workspaces and a model tool call", async () => {
  let out = "";
  let err = "";
  const io: Io = {
    cwd: process.cwd(),
    env: {},
    ghToken: () => null,
    readFile: async (path) => readFile(path, "utf8").catch(() => null),
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
  };
  const code = await run(["plugin", "test", "packages/cli/test/fixtures/plugin-test/positive", "--json"], io);
  expect(err).toBe("");
  const report = JSON.parse(out);
  expect(report.checks.filter((check: { passed: boolean }) => !check.passed)).toEqual([]);
  expect(code).toBe(0);
  expect(report.checks.map((check: { name: string }) => check.name)).toEqual(
    expect.arrayContaining([
      "tracker.reference.read-events",
      "tracker.reference.write",
      "forge.reference.read-events",
      "forge.reference.merge",
      "runtime.reference.launch",
      "runtime.reference.deliver",
      "runtime.reference.stop",
      "runtime.reference.normal-exit",
      "node.reference.launch",
      "model.reference.tool-call",
    ]),
  );
}, 30_000);

test("plugin test stops a real worker whose launch returns after the deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "armada-plugin-late-"));
  const marker = join(dir, "stopped");
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        type: "module",
        main: "index.mjs",
        armada: {
          id: "late",
          version: "1.0.0",
          pluginApi: "^0.1.0",
          enabledByDefault: true,
          description: "Late worker cleanup regression",
          contributions: { runtime: { late: { config: true, secrets: [] } } },
        },
      }),
    );
    await writeFile(
      join(dir, "index.mjs"),
      await readFile(new URL("./fixtures/plugin-test/late-launch/index.mjs", import.meta.url), "utf8"),
    );
    await writeFile(join(dir, "armada-plugin.test.json"), JSON.stringify({ runtime: { late: { marker } } }));
    const { createExec } = await import("../src/spawn.ts");
    const result = await createExec()(process.execPath, ["packages/cli/src/main.ts", "plugin", "test", dir], {
      cwd: process.cwd(),
      timeoutMs: 12_000,
      processGroup: true,
      env: { PATH: process.env.PATH },
    });
    expect(result.timedOut).not.toBe(true);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL runtime.late.launch: check timed out after 5 seconds");
    expect(result.stdout).not.toContain("must not continue");
    expect(await readFile(marker, "utf8")).toBe("stopped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
