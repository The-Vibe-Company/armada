import { join } from "node:path";

/**
 * Set (to anything but `0`, `false` or nothing) to run the shell without a window or a dock
 * icon (THE-2234): the daemon starts, the shell prints one readiness line and waits for a
 * signal. Workers and CI smoke-test a build this way, never on the owner's desktop.
 */
export const HEADLESS_VARIABLE = "ARMADA_DESKTOP_HEADLESS";
/** armadad's catalog, a JSON array of projects. */
export const PROJECTS_VARIABLE = "ARMADA_DESKTOP_PROJECTS";
/** armadad's event log. */
export const DATABASE_VARIABLE = "ARMADA_DESKTOP_DATABASE";

type Env = Record<string, string | undefined>;

export function headlessRequested(env: Env): boolean {
  const value = (env[HEADLESS_VARIABLE] ?? "").trim().toLowerCase();
  // An unrecognised value turns headless on: a window that opens by surprise is the bug.
  return value !== "" && value !== "0" && value !== "false";
}

export type DaemonData = { database: string; projects: string };

/**
 * The daemon's catalog and log: the explicit paths, else `projects.json` and `fleet.sqlite`
 * under Electron's user data. A headless shell takes explicit paths only: it never opens the
 * fleet of the account it runs under.
 */
export function daemonData(env: Env, userData: string, headless: boolean): DaemonData {
  const projects = env[PROJECTS_VARIABLE]?.trim() || undefined;
  const database = env[DATABASE_VARIABLE]?.trim() || undefined;
  if (headless && (!projects || !database))
    throw new Error(
      `${HEADLESS_VARIABLE} needs ${PROJECTS_VARIABLE} and ${DATABASE_VARIABLE}: a headless shell never opens this account's own fleet`,
    );
  return {
    projects: projects ?? join(userData, "projects.json"),
    database: database ?? join(userData, "fleet.sqlite"),
  };
}

/**
 * The environment of a headless shell's daemon: its own configuration directory, app
 * configuration and file keychain under the shell's disposable directory, so it never reads
 * or rewrites the account's `~/.config/armada`, its enabled plugins or its login keychain
 * (which could raise a prompt on the owner's desktop). An explicit value wins; an empty one
 * counts as unset, as the XDG rule has it.
 */
export function headlessDaemonEnv(env: Env, dataDir: string): Env {
  return {
    XDG_CONFIG_HOME: join(dataDir, "config"),
    ARMADA_APP_CONFIG: join(dataDir, "config.json"),
    ARMADA_KEYCHAIN: "file",
    ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== "")),
  };
}

/** Linux without a display server: Chromium's headless Ozone platform lets Electron start without X or Wayland. */
export function noDisplay(platform: NodeJS.Platform, env: Env): boolean {
  return platform === "linux" && !env.DISPLAY?.trim() && !env.WAYLAND_DISPLAY?.trim();
}

export type HeadlessReadiness = {
  headless: true;
  url: string;
  wsUrl: string;
  /** `BrowserWindow.getAllWindows().length`: 0, or the headless shell is broken. */
  windows: number;
  /** `app.dock.isVisible()` on macOS; false elsewhere. */
  dockVisible: boolean;
};

/** The one line a headless shell prints on stdout once its daemon is ready; the test and a worker read it. */
export const readinessLine = (readiness: HeadlessReadiness): string => JSON.stringify(readiness);

/** The headless shell's readiness line, parsed back; null for any other stdout line. */
export function parseReadiness(line: string): HeadlessReadiness | null {
  try {
    const value = JSON.parse(line);
    if (
      value?.headless !== true ||
      typeof value.url !== "string" ||
      typeof value.wsUrl !== "string" ||
      !Number.isSafeInteger(value.windows) ||
      typeof value.dockVisible !== "boolean"
    )
      return null;
    return {
      headless: true,
      url: value.url,
      wsUrl: value.wsUrl,
      windows: value.windows,
      dockVisible: value.dockVisible,
    };
  } catch {
    return null;
  }
}
