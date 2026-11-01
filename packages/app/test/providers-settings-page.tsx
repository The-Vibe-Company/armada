// Settings as the app routes it (THE-2075), alone in a page, for
// test/providers-settings.test.tsx: the app's own daemon client over a fake
// socket the test drives through `window.fake` (what the client sent, a frame
// from the daemon), the desktop shell's bridge recording each address it is
// asked to open, and the room's harness label that reads a display name.
import { PROTOCOL_VERSION } from "@armada/protocol";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useRoute } from "../src/lib/route";
import { createDaemonClient, type SocketLike } from "../src/protocol/client";
import { DaemonProvider } from "../src/protocol/store";
import { HarnessName } from "../src/room/Ship";
import { Settings } from "../src/screens/Settings";

const sent: Record<string, unknown>[] = [];
const opened: string[] = [];
let socket: SocketLike | null = null;

window.armadaShell = { reveal() {}, setBadge() {}, openExternal: (url) => opened.push(url) };
// A sign-in's page opens through `window.open`, which the desktop shell hands to the system browser.
window.open = (url) => {
  opened.push(String(url));
  return null;
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
  opened,
  open: () => flushSync(() => socket?.onopen?.()),
  /** One frame from the daemon, drawn before it returns. */
  receive(message: Record<string, unknown>) {
    flushSync(() => socket?.onmessage?.({ data: JSON.stringify({ version: PROTOCOL_VERSION, ...message }) }));
  },
};

function Routed() {
  const route = useRoute();
  return (
    <>
      <div data-harness>
        <HarnessName harness="codex" />
      </div>
      {route.kind === "settings" ? (
        <Settings section={route.section} detail={route.detail} address="ws://127.0.0.1:4824/" onReload={() => {}} />
      ) : (
        <p data-elsewhere>{window.location.hash}</p>
      )}
    </>
  );
}

client.start();
const box = document.getElementById("root");
if (box)
  flushSync(() =>
    createRoot(box).render(
      <DaemonProvider client={client}>
        <Routed />
      </DaemonProvider>,
    ),
  );
