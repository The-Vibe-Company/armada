import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, shell } from "electron";
import { type DaemonAddress, DaemonProcess, RESTART_EXIT_CODE, restartDaemon } from "./daemon.ts";

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
    const start = (port: number) => {
      daemon = new DaemonProcess({
        executable: process.execPath,
        entry: fileURLToPath(new URL("./armadad.js", import.meta.url)),
        database: process.env.ARMADA_DESKTOP_DATABASE ?? join(dataDir, "fleet.sqlite"),
        projects: process.env.ARMADA_DESKTOP_PROJECTS ?? join(dataDir, "projects.json"),
        staticDir: fileURLToPath(new URL("../../../app/dist/", import.meta.url)),
        port,
        restartable: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      return daemon;
    };
    let address = await start(0).ready;
    if (quitting) return;
    const appUrl = (at: DaemonAddress) => {
      const url = new URL(at.url);
      url.searchParams.set("daemon", at.wsUrl);
      return url.toString();
    };
    // The app's Restart (the Plugins screen) ends the daemon with RESTART_EXIT_CODE: start it again.
    const supervise = (child: DaemonProcess) =>
      void child.exited.then(async ({ code }) => {
        if (quitting) return;
        if (code === RESTART_EXIT_CODE) {
          try {
            const next = await restartDaemon(address, start, () => quitting);
            if (quitting) return;
            supervise(daemon as DaemonProcess);
            if (next.url !== address.url) {
              address = next;
              await window?.loadURL(appUrl(next));
            }
            return;
          } catch {
            if (quitting) return;
          }
        }
        console.error("Armada: the daemon stopped unexpectedly.");
        exitCode = 1;
        app.quit();
      });
    supervise(daemon as DaemonProcess);
    window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 800,
      minHeight: 560,
      show: false,
      title: "Armada",
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    // No window of its own: a link a message opens apart (the room's markdown, THE-2050) goes to the system browser.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => {});
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      const target = new URL(url);
      if (target.origin !== address.url) event.preventDefault();
      // A V1 session's Conductor workspace (the session page's Open the session, THE-2045)
      // is the one link the window hands to another app.
      if (target.protocol === "conductor:") void shell.openExternal(url).catch(() => {});
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.once("ready-to-show", () => window?.show());
    await window.loadURL(appUrl(address));
  } catch {
    if (quitting) return;
    console.error(
      "Armada: could not open the app. Check ARMADA_DESKTOP_PROJECTS and ARMADA_DESKTOP_DATABASE; see packages/desktop/README.md.",
    );
    exitCode = 1;
    app.quit();
  }
});
