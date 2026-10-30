// The window's preload (THE-2055), sandboxed: it exposes the shell's two
// notification calls and the system browser (THE-2071) to the app as
// `window.armadaShell`, and nothing else.
import { contextBridge, ipcRenderer } from "electron";
import { BADGE_CHANNEL, OPEN_EXTERNAL_CHANNEL, REVEAL_CHANNEL } from "./bridge.ts";

contextBridge.exposeInMainWorld("armadaShell", {
  reveal: () => ipcRenderer.send(REVEAL_CHANNEL),
  setBadge: (count: number) => ipcRenderer.send(BADGE_CHANNEL, count),
  openExternal: (url: string) => ipcRenderer.send(OPEN_EXTERNAL_CHANNEL, url),
});
