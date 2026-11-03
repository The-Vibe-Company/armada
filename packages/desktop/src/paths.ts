import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the packaged bundle keeps the room's built files, under Contents/Resources (an extra resource). */
export const PACKAGED_APP_DIR = "app";
/** The dock icon under Contents/Resources (an extra resource; the bundle's own icon is resources/icon.icns). */
export const PACKAGED_ICON = "icon.png";
/** The main process's build output, relative to the app's root; unpacked from the asar (`asarUnpack` in packaging.ts). */
export const MAIN_OUTPUT = "out/main";
/** The bundled daemon entry, under MAIN_OUTPUT with the chunks it shares with the shell's own entry. */
export const DAEMON_ENTRY = `${MAIN_OUTPUT}/armadad.js`;

export type ShellLocation = {
  /** `app.isPackaged`: the main process runs from an installed bundle. */
  packaged: boolean;
  /** `process.resourcesPath`: the bundle's Contents/Resources; read only when packaged. */
  resourcesPath: string;
  /** `import.meta.url` of the built main module, out/main/index.js. */
  mainUrl: string;
};

export type ShellPaths = {
  /** The room's built files the daemon serves (packages/app/dist in a checkout). */
  staticDir: string;
  /** The mark on its tile, set on the dock and the window at launch. */
  icon: string;
  /** The bundled armadad entry the shell runs under its own executable in Node mode. */
  daemonEntry: string;
};

/**
 * The three files the shell needs besides itself: under the bundle's resources
 * when packaged (THE-2229), under the checkout when run from source. The daemon's
 * data directory is not here: it stays `app.getPath("userData")`.
 */
export function shellPaths({ packaged, resourcesPath, mainUrl }: ShellLocation): ShellPaths {
  if (packaged)
    return {
      staticDir: join(resourcesPath, PACKAGED_APP_DIR),
      icon: join(resourcesPath, PACKAGED_ICON),
      daemonEntry: join(resourcesPath, "app.asar.unpacked", ...DAEMON_ENTRY.split("/")),
    };
  return {
    staticDir: fileURLToPath(new URL("../../../app/dist/", mainUrl)),
    icon: fileURLToPath(new URL("../../resources/icon.png", mainUrl)),
    daemonEntry: fileURLToPath(new URL("./armadad.js", mainUrl)),
  };
}
