// A project's room alone in a page on a fake daemon client (THE-2085), for
// test/room-panel.test.tsx's and test/room-agent-lane.test.tsx's browser
// halves: `Room` reading the folded state and the log the test seeds
// (`window.seed`, set before the page loads), the client answering the room's
// requests and recording them in `window.daemon.requests`; `window.daemon.show`
// hands it a later fold, as the subscription would; `window.daemon.frame` a
// frame of the coordinator's turn, `window.daemon.say` a conversation the
// room reads again, and `window.daemon.refuse` the line a send is refused
// with (THE-2086's Merge waits on them).
import type { ChatItem, ProtocolEvent, ServerMessage, Snapshot } from "@armada/protocol";
import { LazyMotion, MotionConfig } from "motion/react";
import { createRoot } from "react-dom/client";
import features from "../src/components/shell/motion-features";
import { type ChatFrame, type DaemonClient, type DaemonState, initialState } from "../src/protocol/client";
import { DaemonProvider } from "../src/protocol/store";
import { Room } from "../src/screens/Room";

const PROJECT = { id: "harbor", name: "Harbor", repository: "example/harbor" };
const NOW = Date.parse("2026-03-10T15:00:00.000Z");
const seed = (window as unknown as { seed: { state: Snapshot["state"]; events: ProtocolEvent[] } }).seed;
const seq = seed.events.at(-1)?.seq ?? 0;

let state: DaemonState = {
  ...initialState,
  status: "live",
  projects: [PROJECT],
  minor: 7,
  fleets: { harbor: { seq, state: seed.state } },
  logs: { harbor: { seq, events: seed.events } },
};
const requests: Record<string, unknown>[] = [];
const listeners = new Set<() => void>();
const chats = new Set<(frame: ChatFrame) => void>();
let conversation: { seq: number; items: ChatItem[] } = { seq, items: [] };
let refusal: string | null = null;

const client: DaemonClient = {
  getState: () => state,
  subscribe: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  start() {},
  stop() {},
  login: async () => {},
  answer: () => {},
  cancel: async () => {},
  logout: async () => {},
  select: async () => {},
  auth: () => () => {},
  connectProvider: async () => {},
  answerProvider: () => {},
  cancelProvider: async () => {},
  disconnectProvider: async () => {},
  inspectProject: async () => {
    throw new Error("Project inspection is outside this fixture");
  },
  addProject: async () => {
    throw new Error("Project addition is outside this fixture");
  },
  removeProject: async () => {
    throw new Error("Project removal is outside this fixture");
  },
  saveCredentials: async () => {},
  setPluginEnabled: async () => {},
  configurePlugin: async () => {},
  setPluginSecret: async () => {},
  restartDaemon: async () => {},
  chat: (listener) => {
    chats.add(listener);
    return () => chats.delete(listener);
  },
  // biome-ignore lint/suspicious/noExplicitAny: the fake answers each request with its own reply type.
  async request(message): Promise<any> {
    requests.push({ ...message });
    const envelope = { version: { major: 1, minor: 7 }, id: `r${requests.length}`, project: PROJECT.id };
    switch (message.type) {
      case "chat.read":
        return {
          ...envelope,
          type: "chat.result",
          seq: conversation.seq,
          coordinator: true,
          items: conversation.items,
        } satisfies ServerMessage;
      case "chat.send":
        if (refusal) throw new Error(refusal);
        return { ...envelope, type: "chat.sent", requestId: message.requestId } satisfies ServerMessage;
      case "owner.answer":
        return { ...envelope, type: "owner.answered", item: message.item } satisfies ServerMessage;
      default:
        throw new Error(`not in this page: ${message.type}`);
    }
  },
};

(window as unknown as { daemon: unknown }).daemon = {
  requests,
  show(next: { state: Snapshot["state"]; events: ProtocolEvent[] }) {
    const at = next.events.at(-1)?.seq ?? seq;
    state = {
      ...state,
      fleets: { harbor: { seq: at, state: next.state } },
      logs: { harbor: { seq: at, events: next.events } },
    };
    for (const listener of listeners) listener();
  },
  frame(frame: ChatFrame) {
    for (const listener of chats) listener(frame);
  },
  /** The coordinator's checkpoint: a conversation the room reads again, as a later `coordinator.*` event makes it. */
  say(items: ChatItem[]) {
    const log = state.logs.harbor ?? { seq, events: [] };
    const at = log.seq + 1;
    const event = {
      seq: at,
      project: PROJECT.id,
      kind: "coordinator.turn",
      at: items.at(-1)?.at ?? "",
      actor: "coordinator",
      payload: {},
    };
    conversation = { seq: at, items };
    state = { ...state, logs: { harbor: { seq: at, events: [...log.events, event as unknown as ProtocolEvent] } } };
    for (const listener of listeners) listener();
  },
  refuse(line: string | null) {
    refusal = line;
  },
  providers(providers: DaemonState["providers"]) {
    state = { ...state, providers };
    for (const listener of listeners) listener();
  },
};

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
