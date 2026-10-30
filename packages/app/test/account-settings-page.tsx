// Settings' Account alone in a page (THE-2071), for test/account-settings.test.tsx:
// the app's own daemon client over a fake socket the test drives through
// `window.fake` (what the client sent, a frame from the daemon), and the
// desktop shell's bridge recording each address it is asked to open.
import { PROTOCOL_VERSION } from "@armada/protocol";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createDaemonClient, type SocketLike } from "../src/protocol/client";
import { DaemonProvider } from "../src/protocol/store";
import { Account } from "../src/settings/Account";

const sent: Record<string, unknown>[] = [];
const opened: string[] = [];
let socket: SocketLike | null = null;

window.armadaShell = { reveal() {}, setBadge() {}, openExternal: (url) => opened.push(url) };

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
  opened,
  open: () => flushSync(() => socket?.onopen?.()),
  /** One frame from the daemon, drawn before it returns. */
  receive(message: Record<string, unknown>) {
    flushSync(() => socket?.onmessage?.({ data: JSON.stringify({ version: PROTOCOL_VERSION, ...message }) }));
  },
};

client.start();
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <DaemonProvider client={client}>
      <Account />
    </DaemonProvider>,
  );
