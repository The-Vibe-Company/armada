// The window's preload (THE-2055), sandboxed: it exposes the shell's two
// notification calls, the system browser (THE-2071) and the folder picker
// (THE-2081) to the app as `window.armadaShell`, and nothing else.
import { contextBridge, ipcRenderer } from "electron";
import { BADGE_CHANNEL, OPEN_EXTERNAL_CHANNEL, PICK_FOLDER_CHANNEL, REVEAL_CHANNEL } from "./bridge.ts";

contextBridge.exposeInMainWorld("armadaShell", {
  reveal: () => ipcRenderer.send(REVEAL_CHANNEL),
  setBadge: (count: number) => ipcRenderer.send(BADGE_CHANNEL, count),
  openExternal: (url: string) => ipcRenderer.send(OPEN_EXTERNAL_CHANNEL, url),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
});
