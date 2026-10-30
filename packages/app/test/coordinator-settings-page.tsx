// Settings › Coordinator alone in a page (THE-2070), for
// test/coordinator-settings.test.tsx's browser half: the Settings page on the
// app's own daemon client over a fake socket. The test reads what the client
// sent and hands it the daemon's answers through `window.daemon`; the pages
// `window.open` would open are only recorded.
import type { ClientMessage } from "@armada/protocol";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createDaemonClient, type SocketLike } from "../src/protocol/client";
import { DaemonProvider } from "../src/protocol/store";
import { Settings } from "../src/screens/Settings";

const sent: ClientMessage[] = [];
const opened: string[] = [];
let socket: SocketLike | null = null;

window.open = (url?: string | URL) => {
  opened.push(String(url));
  return null;
};

const client = createDaemonClient({
  url: "ws://127.0.0.1:4824/",
  open() {
    const fake: SocketLike = {
      send: (data) => sent.push(JSON.parse(data)),
      close() {},
      onopen: null,
      onmessage: null,
      onclose: null,
    };
    socket = fake;
    return fake;
  },
  schedule: () => () => {},
});

(window as unknown as { daemon: unknown }).daemon = {
  /** Every message the client sent, oldest first. */
  get sent() {
    return sent;
  },
  /** Every page the app asked the browser to open. */
  get opened() {
    return opened;
  },
  open() {
    flushSync(() => socket?.onopen?.());
  },
  /** One message from the daemon, as it would arrive on the socket. */
  receive(message: Record<string, unknown>) {
    flushSync(() => socket?.onmessage?.({ data: JSON.stringify(message) }));
  },
};

client.start();
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <DaemonProvider client={client}>
      <Settings section="coordinator" address="ws://127.0.0.1:4824/" onReload={() => {}} />
    </DaemonProvider>,
  );
