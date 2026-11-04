import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, autoUpdater as nativeUpdater, shell } from "electron";
import {
  BADGE_CHANNEL,
  badgeCount,
  externalUrl,
  fromApp,
  OPEN_EXTERNAL_CHANNEL,
  PICK_FOLDER_CHANNEL,
  pickedFolder,
  REVEAL_CHANNEL,
} from "./bridge.ts";
import { type DaemonAddress, DaemonProcess, RESTART_EXIT_CODE, restartDaemon } from "./daemon.ts";
import { daemonData, headlessDaemonEnv, headlessRequested, readinessLine } from "./headless.ts";
import { shellPaths } from "./paths.ts";
import { STARTUP_URL } from "./startup.ts";
import {
  readShown,
  redact,
  UPDATE_FEED,
  UpdateController,
  type Updater,
  updatesEnabled,
  writeShown,
} from "./updates.ts";

app.setName("Armada");
// A headless shell (THE-2234): no window, no dock icon, a disposable user data directory and only
// the catalog and log it was given. Workers and CI smoke-test a build with it; the owner's desktop
// and the owner's own fleet are never touched. Everything here runs before Electron is ready
// (Chromium's display platform is already chosen by then: on Linux without a display the launcher
// passes OZONE_HEADLESS_SWITCH, see headless.ts).
const HEADLESS = headlessRequested(process.env);
const HEADLESS_DATA = HEADLESS ? mkdtempSync(join(tmpdir(), "armada-desktop-headless-")) : undefined;
if (HEADLESS_DATA) {
  app.setPath("userData", HEADLESS_DATA);
  app.dock?.hide();
  app.disableHardwareAcceleration();
}
// The room's built files, the icon and the daemon entry: under the installed bundle's resources when
// packaged (THE-2229), under the checkout when run from source.
const PATHS = shellPaths({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, mainUrl: import.meta.url });
// The app's icon (resources/icon.png, the mark on its tile): the dock on macOS, the window elsewhere.
const ICON = PATHS.icon;
let daemon: DaemonProcess | undefined;
let window: BrowserWindow | undefined;
let quitting = false;
let exitCode = 0;
// Set once the daemon has stopped for an update: electron-updater's quit then goes through untouched.
let installing = false;
// Updates (THE-2231): an installed app only, never from source, headless or with ARMADA_DESKTOP_NO_UPDATE.
const UPDATES = updatesEnabled({ packaged: app.isPackaged, headless: HEADLESS, env: process.env });
let updates: UpdateController | undefined;

app.on("before-quit", (event) => {
  if (installing) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void (daemon?.stop() ?? Promise.resolve()).then(() => {
    if (HEADLESS_DATA) rmSync(HEADLESS_DATA, { recursive: true, force: true });
    app.exit(exitCode);
  });
});
app.on("window-all-closed", () => app.quit());
app.on("activate", () => window?.focus());
// Every signal asks for the one quit (before-quit stops the daemon once); a repeated one must not
// end Electron by default and orphan the daemon.
process.on("SIGTERM", () => app.quit());
process.on("SIGINT", () => app.quit());

void app.whenReady().then(async () => {
  if (quitting) return;
  if (HEADLESS) app.dock?.hide();
  else if (process.platform === "darwin") app.dock?.setIcon(nativeImage.createFromPath(ICON));
  if (!HEADLESS) setMenu();
  try {
    // Refused before any window or daemon when a headless shell was not told which fleet to open.
    const data = daemonData(process.env, app.getPath("userData"), HEADLESS);
    if (!HEADLESS) {
      window = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 800,
        minHeight: 560,
        show: false,
        title: "Armada",
        icon: ICON,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          preload: fileURLToPath(new URL("../preload/preload.cjs", import.meta.url)),
        },
      });
      window.once("ready-to-show", () => window?.show());
    }
    const load = async (url: string) => {
      try {
        await window?.loadURL(url);
      } catch (error) {
        // The static page has no external resource or private address to disclose.
        const target = url === STARTUP_URL ? "startup page" : url;
        throw new Error(`could not load ${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    if (window) await load(STARTUP_URL);
    if (quitting) return;
    const start = (port: number) => {
      daemon = new DaemonProcess({
        onStarting: (events) => {
          if (events === undefined || quitting || window?.webContents.getURL() !== STARTUP_URL) return;
          void window?.webContents
            .executeJavaScript(
              `document.getElementById("progress").textContent = ${JSON.stringify(`Reading ${events.toLocaleString("en-US")} events`)};`,
            )
            .catch(() => {});
        },
        executable: process.execPath,
        entry: PATHS.daemonEntry,
        database: data.database,
        projects: data.projects,
        staticDir: PATHS.staticDir,
        port,
        restartable: true,
        env: {
          ...(HEADLESS_DATA ? headlessDaemonEnv(process.env, HEADLESS_DATA) : process.env),
          ELECTRON_RUN_AS_NODE: "1",
        },
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
    // A headless shell announces its daemon's addresses on stdout instead of loading the app.
    const announce = (at: DaemonAddress) =>
      console.log(
        readinessLine({
          headless: true,
          url: at.url,
          wsUrl: at.wsUrl,
          windows: BrowserWindow.getAllWindows().length,
          dockVisible: app.dock?.isVisible() ?? false,
        }),
      );
    // The app's Restart (the Plugins screen) ends the daemon with RESTART_EXIT_CODE: start it again.
    const supervise = (child: DaemonProcess) =>
      void child.exited.then(async ({ code, signal }) => {
        if (quitting) return;
        if (code === RESTART_EXIT_CODE) {
          try {
            const next = await restartDaemon(address, start, () => quitting);
            if (quitting) return;
            supervise(daemon as DaemonProcess);
            if (next.url !== address.url) {
              address = next;
              if (window) await load(appUrl(next));
              else announce(next);
            }
            return;
          } catch (error) {
            if (quitting) return;
            console.error(
              `Armada: could not restart the daemon: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        console.error(`Armada: the daemon stopped unexpectedly (${signal ? `signal ${signal}` : `code ${code}`}).`);
        exitCode = 1;
        app.quit();
      });
    supervise(daemon as DaemonProcess);
    if (!window) {
      announce(address);
      return;
    }
    // The app's notifications (THE-2055): a click brings the window forward, the dock counts those not yet read.
    // Only the app's own window, from a page of the daemon's origin (never a frame of another).
    const own = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
      window !== undefined && event.sender === window.webContents && fromApp(event.senderFrame?.url, address.url);
    ipcMain.on(REVEAL_CHANNEL, (event) => {
      if (!window || !own(event)) return;
      if (window.isMinimized()) window.restore();
      window.show();
      if (process.platform === "darwin") app.focus({ steal: true });
      window.focus();
    });
    ipcMain.on(BADGE_CHANNEL, (event, count: unknown) => {
      if (own(event)) app.setBadgeCount(badgeCount(count));
    });
    // Armada's device page (THE-2071), in the system browser: http or https, never the app's own pages.
    ipcMain.on(OPEN_EXTERNAL_CHANNEL, (event, value: unknown) => {
      const url = own(event) ? externalUrl(value, address.url) : null;
      if (url) void shell.openExternal(url).catch(() => {});
    });
    // The hangar's Add project (THE-2081): the system's folder dialog, on the app's window; null when cancelled.
    ipcMain.handle(PICK_FOLDER_CHANNEL, async (event) => {
      if (!window || !own(event)) return null;
      const result = await dialog.showOpenDialog(window, {
        title: "Add a project",
        buttonLabel: "Choose",
        properties: ["openDirectory", "createDirectory"],
      });
      return pickedFolder(result);
    });
    window.on("focus", () => app.setBadgeCount(0));
    // No window of its own: a link a message opens apart (the room's markdown, THE-2050) goes to the system
    // browser or mail app; never the app's own pages, which only this window shows.
    window.webContents.setWindowOpenHandler(({ url }) => {
      const external = /^(https?|mailto):/i.test(url) && !url.startsWith(`${address.url}/`) && url !== address.url;
      if (external) void shell.openExternal(url).catch(() => {});
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      const target = new URL(url);
      if (target.origin !== address.url) event.preventDefault();
      // A V1 session's Conductor workspace (the session page's Open the session, THE-2045)
      // is the one link the window hands to another app.
      if (target.protocol === "conductor:") void shell.openExternal(url).catch(() => {});
    });
    // Notifications only (THE-2055): the app shows them when its window is in the background, silent.
    window.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) =>
      callback(permission === "notifications" && fromApp(details.requestingUrl, address.url)),
    );
    await load(appUrl(address));
    if (UPDATES && !quitting) updates = await startUpdates();
  } catch (error) {
    if (quitting) return;
    console.error(`Armada: could not open the app: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
    app.quit();
  }
});

const updateLog = (message: string) => console.error(`Armada: updater: ${redact(message)}`);

/** The app menu: About (the version) and Check for Updates…, then the platform's usual menus. */
function setMenu(): void {
  app.setAboutPanelOptions({ applicationName: "Armada", applicationVersion: app.getVersion(), version: "" });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Armada",
        submenu: [
          { role: "about", label: "About Armada" },
          {
            label: "Check for Updates…",
            enabled: UPDATES,
            click: () => void updates?.check(true),
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

/**
 * electron-updater on the public repository's releases: downloads in the background, installs on
 * quit, asks once per version before restarting (src/updates.ts decides). Loaded only when enabled.
 */
async function startUpdates(): Promise<UpdateController> {
  const { autoUpdater } = await import("electron-updater");
  autoUpdater.logger = {
    info: (message?: unknown) => updateLog(String(message)),
    warn: (message?: unknown) => updateLog(String(message)),
    error: (message?: unknown) => updateLog(String(message)),
    debug: () => {},
  };
  autoUpdater.setFeedURL({ ...UPDATE_FEED });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const memory = join(app.getPath("userData"), "updates.json");
  const parent = () => (window && !window.isDestroyed() ? window : undefined);
  const box = (options: Electron.MessageBoxOptions) => {
    const owner = parent();
    return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
  };
  const updater: Updater = {
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    // Not silent, and Armada opens again once installed.
    quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
  };
  const controller = new UpdateController(
    updater,
    {
      askRestart: async (version) => {
        const { response } = await box({
          type: "info",
          message: `Armada ${version} is ready.`,
          detail: "Restart now to install it, or Later to install it when you quit Armada.",
          buttons: ["Restart now", "Later"],
          defaultId: 0,
          cancelId: 1,
        });
        return response === 0;
      },
      offerRelease: async (version, url) => {
        const { response } = await box({
          type: "info",
          message: `Armada ${version} is available.`,
          detail: "This build is not signed, so macOS cannot install the update in place. Download it from GitHub.",
          buttons: ["Open release page", "Close"],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) await shell.openExternal(url).catch(() => {});
      },
      tellManual: async (outcome) => {
        await box(
          outcome === "up-to-date"
            ? { type: "info", message: `Armada ${app.getVersion()} is up to date.`, buttons: ["OK"] }
            : {
                type: "warning",
                message: "Armada could not check for updates.",
                detail: "Try again later.",
                buttons: ["OK"],
              },
        );
      },
      // As on quit (before-quit): the daemon closes its sockets and SQLite before the app is replaced.
      stopDaemon: async () => {
        quitting = true;
        await (daemon?.stop() ?? Promise.resolve());
        installing = true;
      },
      shown: readShown(memory),
      remember: (shown) => writeShown(memory, shown),
      log: updateLog,
    },
    app.isPackaged,
  );
  autoUpdater.on("update-available", (info) => void controller.found(info.version));
  autoUpdater.on("update-not-available", () => controller.none());
  autoUpdater.on("update-downloaded", (info) => void controller.found(info.version));
  autoUpdater.on("error", (error) => void controller.failed(error));
  nativeUpdater.on("update-downloaded", () => void controller.ready());
  controller.schedule();
  updateLog(`on, from the releases of ${UPDATE_FEED.owner}/${UPDATE_FEED.repo}`);
  return controller;
}
