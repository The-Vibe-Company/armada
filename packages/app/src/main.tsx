import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DEV_DAEMON_URL, daemonUrl } from "./protocol/address";
import { browserSocket } from "./protocol/browser";
import { createDaemonClient } from "./protocol/client";

const address = daemonUrl(
  window.location,
  import.meta.env.VITE_ARMADA_DAEMON_URL || (import.meta.env.DEV ? DEV_DAEMON_URL : undefined),
);
const client = createDaemonClient({
  url: address,
  open: browserSocket,
  schedule: (run, ms) => {
    const timer = window.setTimeout(run, ms);
    return () => window.clearTimeout(timer);
  },
});
client.start();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <App client={client} address={address} onReload={() => window.location.reload()} />
  </StrictMode>,
);
