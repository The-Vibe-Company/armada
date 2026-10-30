// A project's room alone in a page on a fake daemon client (THE-2085), for
// test/room-panel.test.tsx's browser half: `Room` reading the folded state and
// the log the test seeds (`window.seed`, set before the page loads), the client
// answering the room's requests and recording them in `window.daemon.requests`.
import type { ProtocolEvent, ServerMessage, Snapshot } from "@armada/protocol";
import { LazyMotion, MotionConfig } from "motion/react";
import { createRoot } from "react-dom/client";
import features from "../src/components/shell/motion-features";
import { type DaemonClient, type DaemonState, initialState } from "../src/protocol/client";
import { DaemonProvider } from "../src/protocol/store";
import { Room } from "../src/screens/Room";

const PROJECT = { id: "harbor", name: "Harbor", repository: "example/harbor" };
const NOW = Date.parse("2026-03-10T15:00:00.000Z");
const seed = (window as unknown as { seed: { state: Snapshot["state"]; events: ProtocolEvent[] } }).seed;
const seq = seed.events.at(-1)?.seq ?? 0;

const state: DaemonState = {
  ...initialState,
  status: "live",
  projects: [PROJECT],
  minor: 7,
  fleets: { harbor: { seq, state: seed.state } },
  logs: { harbor: { seq, events: seed.events } },
};
const requests: Record<string, unknown>[] = [];

const client: DaemonClient = {
  getState: () => state,
  subscribe: () => () => {},
  start() {},
  stop() {},
  login: async () => {},
  answer: () => {},
  cancel: async () => {},
  logout: async () => {},
  select: async () => {},
  auth: () => () => {},
  saveCredentials: async () => {},
  setPluginEnabled: async () => {},
  configurePlugin: async () => {},
  setPluginSecret: async () => {},
  restartDaemon: async () => {},
  chat: () => () => {},
  // biome-ignore lint/suspicious/noExplicitAny: the fake answers each request with its own reply type.
  async request(message): Promise<any> {
    requests.push({ ...message });
    const envelope = { version: { major: 1, minor: 7 }, id: `r${requests.length}`, project: PROJECT.id };
    switch (message.type) {
      case "chat.read":
        return { ...envelope, type: "chat.result", seq, coordinator: true, items: [] } satisfies ServerMessage;
      case "owner.answer":
        return { ...envelope, type: "owner.answered", item: message.item } satisfies ServerMessage;
      default:
        throw new Error(`not in this page: ${message.type}`);
    }
  },
};

(window as unknown as { daemon: unknown }).daemon = { requests };

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <DaemonProvider client={client}>
      {/* The shell's motion, as the app gives every page; the room fills the window as in the shell's main. */}
      <MotionConfig reducedMotion="user">
        <LazyMotion features={features} strict>
          <main className="h-screen">
            <Room project={PROJECT.id} now={NOW} zone="UTC" />
          </main>
        </LazyMotion>
      </MotionConfig>
    </DaemonProvider>,
  );
