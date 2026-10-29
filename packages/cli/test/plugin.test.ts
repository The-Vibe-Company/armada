import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

test("plugin test exercises recorded reads, writes, headless workers, workspaces and a model tool call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-plugin-headless-"));
  try {
    // Reproduce BSD script's failure without depending on the host OS or a terminal.
    await writeFile(
      join(directory, "script"),
      '#!/bin/sh\necho "script: tcgetattr/ioctl: Operation not supported on socket" >&2\nexit 2\n',
      { mode: 0o755 },
    );
    const { createExec } = await import("../src/spawn.ts");
    const result = await createExec()(
      process.execPath,
      ["packages/cli/src/main.ts", "plugin", "test", "packages/cli/test/fixtures/plugin-test/positive", "--json"],
      {
        cwd: process.cwd(),
        timeoutMs: 20_000,
        processGroup: true,
        env: { PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`, XDG_CONFIG_HOME: directory },
      },
    );
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.checks.filter((check: { passed: boolean }) => !check.passed)).toEqual([]);
    expect(result.code).toBe(0);
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("a handle returned after cancellation is stopped before the runner can observe it", async () => {
  const { spawn, execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { PluginRegistry } = await import("@armada/daemon/plugins");
  const { manifestSchema } = await import("@armada/plugin-api");
  const { runSeamChecks } = await import("../src/plugin-checks.ts");
  const execute = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), "armada-plugin-cancel-"));
  const manifest = manifestSchema.parse({
    id: "late",
    version: "1.0.0",
    pluginApi: "^0.1.0",
    enabledByDefault: true,
    description: "Late worker cleanup regression",
    contributions: { runtime: { late: { config: true, secrets: [] } } },
  });
  const registry = new PluginRegistry();
  const activation = registry.activation(manifest);
  const controller = new AbortController();
  const cancellation = new Error("fixture deadline");
  let entered!: () => void;
  const launchEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const returnedHandle = new Promise<void>((resolve) => {
    release = resolve;
  });
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  let stopped = 0;
  let observed = 0;
  let lateAction: Promise<void> | undefined;
  activation.register.runtime("late", {
    async prepare({ repository, branch }) {
      await execute("git", ["-C", repository, "switch", "--quiet", "-c", branch]);
      return { id: "late", node: "local", path: repository };
    },
    async launch({ worker }) {
      child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      exited = new Promise((resolve) => {
        child?.once("exit", resolve);
      });
      entered();
      await returnedHandle;
      return { ...worker, handle: "late-child" };
    },
    async observe() {
      observed++;
      return { state: "unknown" };
    },
    async deliver() {
      throw new Error("cancelled launch cannot deliver");
    },
    async stop() {
      stopped++;
      child?.kill("SIGTERM");
      await exited;
    },
  });
  activation.commit();
  try {
    await runSeamChecks({
      registry,
      manifest,
      events: [],
      directory,
      fixtureRoot: fileURLToPath(new URL("../../plugin-api/fixtures/", import.meta.url)),
      endpoint: "http://127.0.0.1",
      requests: [],
      check: async (name, action) => {
        if (name.endsWith(".launch")) {
          lateAction = action(controller.signal);
          await launchEntered;
          controller.abort(cancellation);
          return false;
        }
        await action(controller.signal);
        return true;
      },
    });
    // The runner already completed its normal finally before this handle exists.
    expect(stopped).toBe(0);
    release();
    await expect(lateAction).rejects.toBe(cancellation);
    expect(stopped).toBe(1);
    expect(observed).toBe(0);
    expect(child?.signalCode).toBe("SIGTERM");
  } finally {
    release();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
