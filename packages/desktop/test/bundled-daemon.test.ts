import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, serverMessageSchema } from "@armada/protocol";
import { EventStore } from "../../daemon/src/store.ts";
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
      ELECTRON_RUN_AS_NODE: "1",
      ARMADA_MODEL_KIND: "openai-compatible",
      ARMADA_MODEL_BASE_URL: "http://fixture.invalid/v1",
      ARMADA_MODEL_NAME: "bundle-model",
      ARMADA_MODEL_API_KEY: randomBytes(24).toString("hex"),
      GITHUB_TOKEN: randomBytes(24).toString("hex"),
      NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
      XDG_CONFIG_HOME: dir,
      ARMADA_KEYCHAIN: "file",
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
