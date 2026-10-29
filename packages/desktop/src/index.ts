import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { DaemonProcess } from "./daemon.ts";

app.setName("Armada");
let daemon: DaemonProcess | undefined;
let window: BrowserWindow | undefined;
let quitting = false;
let exitCode = 0;

app.on("before-quit", (event) => {
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void (daemon?.stop() ?? Promise.resolve()).then(() => app.exit(exitCode));
});
app.on("window-all-closed", () => app.quit());
app.on("activate", () => window?.focus());
process.once("SIGTERM", () => app.quit());
process.once("SIGINT", () => app.quit());

void app.whenReady().then(async () => {
  if (quitting) return;
  try {
    const dataDir = app.getPath("userData");
    daemon = new DaemonProcess({
      executable: process.execPath,
      entry: fileURLToPath(new URL("./armadad.js", import.meta.url)),
      database: process.env.ARMADA_DESKTOP_DATABASE ?? join(dataDir, "fleet.sqlite"),
      projects: process.env.ARMADA_DESKTOP_PROJECTS ?? join(dataDir, "projects.json"),
      staticDir: fileURLToPath(new URL("../../../app/dist/", import.meta.url)),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    const address = await daemon.ready;
    if (quitting) return;
    void daemon.exited.then(() => {
      if (!quitting) {
        console.error("Armada: the daemon stopped unexpectedly.");
        exitCode = 1;
        app.quit();
      }
    });
    window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 800,
      minHeight: 560,
      show: false,
      title: "Armada",
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== address.url) event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.once("ready-to-show", () => window?.show());
    const url = new URL(address.url);
    url.searchParams.set("daemon", address.wsUrl);
    await window.loadURL(url.toString());
  } catch {
    if (quitting) return;
    console.error(
      "Armada: could not open the app. Check ARMADA_DESKTOP_PROJECTS and ARMADA_DESKTOP_DATABASE; see packages/desktop/README.md.",
    );
    exitCode = 1;
    app.quit();
  }
});
