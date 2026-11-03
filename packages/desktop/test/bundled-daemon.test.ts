import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, serverMessageSchema } from "@armada/protocol";
import { EventStore } from "../../daemon/src/store.ts";
import { DaemonProcess } from "../src/daemon.ts";
import { type HeadlessReadiness, noDisplay, OZONE_HEADLESS_SWITCH, parseReadiness } from "../src/headless.ts";

const buildBundle = () => {
  execFileSync("bun", ["run", "build"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    timeout: 60000,
    stdio: "pipe",
  });
};
// Bun's node:test bridge ignores before()'s timeout and defaults to five seconds.
// Keep the existing one-minute setup budget in both runners; behavior deadlines stay separate.
if (process.versions.bun) {
  const { beforeAll } = createRequire(import.meta.url)("bun:test");
  beforeAll(buildBundle, 60000);
} else {
  before(buildBundle, { timeout: 60000 });
}

test("Electron's bundled daemon starts a configured coordinator and reads credentials through native keyring", {
  timeout: 20000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-desktop-bundle-"));
  const projects = join(dir, "projects.json");
  writeFileSync(projects, JSON.stringify([{ id: "bundle", name: "Bundle", repository: "example/bundle" }]));
  const preload = fileURLToPath(new URL("./fixtures/keychain.cjs", import.meta.url));
  const daemon = new DaemonProcess({
    // Outside Electron, its package resolves to the bundled executable's path.
    executable: createRequire(import.meta.url)("electron"),
    entry: fileURLToPath(new URL("../out/main/armadad.js", import.meta.url)),
    database: join(dir, "fleet.sqlite"),
    projects,
    staticDir: dir,
    env: {
      ...process.env,
      // This packaging test alone selects native storage, with every read stubbed
      // by fixtures/keychain.cjs before the bundled daemon imports its adapters.
      ARMADA_KEYCHAIN: "native-fixture",
      ELECTRON_RUN_AS_NODE: "1",
      ARMADA_MODEL_KIND: "openai-compatible",
      ARMADA_MODEL_BASE_URL: "http://fixture.invalid/v1",
      ARMADA_MODEL_NAME: "bundle-model",
      ARMADA_MODEL_API_KEY: randomBytes(24).toString("hex"),
      GITHUB_TOKEN: randomBytes(24).toString("hex"),
      NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
      XDG_CONFIG_HOME: dir,
      ARMADA_APP_CONFIG: join(dir, "config.json"),
    },
  });
  let socket: WebSocket | undefined;
  try {
    const address = await daemon.ready;
    socket = new WebSocket(address.wsUrl);
    await once(socket, "open", { signal: t.signal });
    const response = once(socket, "message", { signal: t.signal });
    socket.send(JSON.stringify({ type: "credentials.status", version: PROTOCOL_VERSION, id: "status" }));
    const [event] = await response;
    const result = serverMessageSchema.parse(JSON.parse(event.data));
    assert.ok(result.type === "credentials.result");
    assert.deepEqual(
      { type: result.type, version: result.version, id: result.id, provider: result.provider, storage: result.storage },
      {
        type: "credentials.result",
        version: PROTOCOL_VERSION,
        id: "status",
        provider: null,
        storage: "os-keychain",
      },
    );
    await daemon.stop();
    const store = new EventStore(join(dir, "fleet.sqlite"));
    try {
      assert.equal(
        store
          .readSince(0, "bundle")
          .some(
            (event) =>
              event.kind === "coordinator.checkpoint" &&
              JSON.stringify(event.payload).includes('"modelId":"bundle-model"'),
          ),
        true,
      );
    } finally {
      store.close();
    }
  } finally {
    socket?.close();
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The headless shell (THE-2234): the built main process under the development Electron, as a worker
// or CI smoke-tests a build. Nothing here may touch the desktop this test runs on.
const electron = createRequire(import.meta.url)("electron") as string;
const desktopPackage = fileURLToPath(new URL("..", import.meta.url));
const shellEnvironment = (home: string): NodeJS.ProcessEnv => {
  // A disposable home: had the shell let its daemon fall back to the account's configuration,
  // it would appear under this home's .config, where the test looks after the run.
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, ARMADA_DESKTOP_HEADLESS: "1", HOME: home };
  // The shell itself runs as Electron; only its daemon child runs as Node.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  // The shell, not this test, keeps its daemon off the account's configuration and keychain
  // (headlessDaemonEnv): the test runner's own disposable values are withheld to prove it.
  delete env.ARMADA_KEYCHAIN;
  delete env.XDG_CONFIG_HOME;
  delete env.ARMADA_APP_CONFIG;
  return env;
};
// Linux switches a launcher passes before Electron runs the main script: a GitHub runner has no
// configured setuid sandbox helper for Electron's zygote (the headless shell creates no renderer, so
// it runs unsandboxed there), and without a display Chromium needs its headless Ozone platform.
const LINUX_SWITCHES =
  process.platform === "linux"
    ? ["--no-sandbox", ...(noDisplay(process.platform, process.env) ? [OZONE_HEADLESS_SWITCH] : [])]
    : [];
const bootShell = (env: NodeJS.ProcessEnv) => {
  const child = spawn(electron, [...LINUX_SWITCHES, desktopPackage], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  return { child, closed, stderr: () => stderr };
};

test("ARMADA_DESKTOP_HEADLESS=1 boots the built shell with no window or dock icon, reachable through its daemon only", {
  timeout: 40000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-desktop-headless-test-"));
  const projects = join(dir, "projects.json");
  writeFileSync(projects, JSON.stringify([{ id: "quiet", name: "Quiet", repository: "example/quiet" }]));
  const home = join(dir, "home");
  const shell = bootShell({
    ...shellEnvironment(home),
    ARMADA_DESKTOP_PROJECTS: projects,
    ARMADA_DESKTOP_DATABASE: join(dir, "fleet.sqlite"),
  });
  let socket: WebSocket | undefined;
  try {
    const lines = createInterface({ input: shell.child.stdout });
    const readiness = await new Promise<HeadlessReadiness>((resolve, reject) => {
      lines.on("line", (line) => {
        const value = parseReadiness(line);
        if (value) resolve(value);
      });
      void shell.closed.then(({ code, signal }) =>
        reject(new Error(`the shell exited before readiness (${signal ?? `code ${code}`}): ${shell.stderr()}`)),
      );
    });
    lines.close();
    assert.equal(readiness.windows, 0, "a headless shell creates no BrowserWindow");
    assert.equal(readiness.dockVisible, false, "a headless shell shows no dock icon");
    // The assertions a worker is allowed: the app's own HTTP and WebSocket endpoints.
    const page = await (await fetch(readiness.url, { signal: t.signal })).text();
    assert.match(page, /<title>Armada/);
    socket = new WebSocket(readiness.wsUrl);
    await once(socket, "open", { signal: t.signal });
    const answer = once(socket, "message", { signal: t.signal });
    socket.send(JSON.stringify({ type: "credentials.status", version: PROTOCOL_VERSION, id: "headless" }));
    const [event] = await answer;
    const result = serverMessageSchema.parse(JSON.parse(event.data));
    assert.equal(result.type, "credentials.result");
    socket.close();
    // Quit ends the daemon too: its port stops answering and the shell exits cleanly.
    shell.child.kill("SIGTERM");
    const exit = await shell.closed;
    assert.deepEqual(exit, { code: 0, signal: null }, shell.stderr());
    await assert.rejects(fetch(readiness.url, { signal: AbortSignal.timeout(5000) }));
    assert.equal(existsSync(join(home, ".config")), false, "the shell kept its daemon off the account's configuration");
  } finally {
    socket?.close();
    shell.child.kill("SIGKILL");
    await shell.closed;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a headless shell without an explicit catalog and log refuses instead of opening the account's own fleet", {
  timeout: 40000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "armada-desktop-headless-refusal-"));
  const env = shellEnvironment(join(dir, "home"));
  delete env.ARMADA_DESKTOP_PROJECTS;
  delete env.ARMADA_DESKTOP_DATABASE;
  const shell = bootShell(env);
  try {
    const exit = await shell.closed;
    assert.equal(exit.code, 1, shell.stderr());
    assert.match(shell.stderr(), /ARMADA_DESKTOP_HEADLESS needs ARMADA_DESKTOP_PROJECTS and ARMADA_DESKTOP_DATABASE/);
  } finally {
    shell.child.kill("SIGKILL");
    await shell.closed;
    rmSync(dir, { recursive: true, force: true });
  }
});
