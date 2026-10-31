// The app alone in a page (THE-2081), for test/add-project.test.tsx: the
// app's own daemon client over a fake socket the test drives through
// `window.fake` (what the client sent, a frame from the daemon), and the
// desktop shell's bridge answering Browse with the folder the test queued;
// `?web` leaves the bridge's folder picker out, as a browser has none.
import { PROTOCOL_VERSION } from "@armada/protocol";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { App } from "../src/App";
import { createDaemonClient, type SocketLike } from "../src/protocol/client";

const sent: Record<string, unknown>[] = [];
const folders: (string | null)[] = [];
let socket: SocketLike | null = null;

window.armadaShell = {
  reveal() {},
  setBadge() {},
  ...(new URLSearchParams(window.location.search).has("web")
    ? {}
    : { pickFolder: async () => folders.shift() ?? null }),
};

const client = createDaemonClient({
  url: "ws://127.0.0.1:4824/",
  open: () => {
    socket = {
      send: (data) => sent.push(JSON.parse(data)),
      close() {},
      onopen: null,
      onmessage: null,
      onclose: null,
    };
    return socket;
  },
  schedule: () => () => {},
});

(window as unknown as { fake: unknown }).fake = {
  sent,
  /** The folder the system's dialog answers next; null is a cancel. */
  pick: (folder: string | null) => folders.push(folder),
  open: () => flushSync(() => socket?.onopen?.()),
  /** One frame from the daemon, drawn before it returns. */
  receive(message: Record<string, unknown>) {
    flushSync(() => socket?.onmessage?.({ data: JSON.stringify({ version: PROTOCOL_VERSION, ...message }) }));
  },
};

client.start();
const box = document.getElementById("root");
if (box)
  flushSync(() => createRoot(box).render(<App client={client} address="ws://127.0.0.1:4824/" onReload={() => {}} />));
