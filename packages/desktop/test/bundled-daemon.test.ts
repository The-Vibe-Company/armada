import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@armada/protocol";
import { DaemonProcess } from "../src/daemon.ts";

before(
  () => {
    execFileSync("bun", ["run", "build"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      timeout: 60000,
      stdio: "pipe",
    });
  },
  { timeout: 60000 },
);

test("Electron's bundled daemon returns credential status through the native keyring package", {
  timeout: 20000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-desktop-bundle-"));
  const projects = join(dir, "projects.json");
  writeFileSync(projects, "[]");
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
      ELECTRON_RUN_AS_NODE: "1",
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
    assert.deepEqual(JSON.parse(event.data), {
      type: "credentials.result",
      version: PROTOCOL_VERSION,
      id: "status",
      provider: null,
      storage: "os-keychain",
    });
  } finally {
    socket?.close();
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
