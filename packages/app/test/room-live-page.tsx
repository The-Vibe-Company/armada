// The room alone in a page on a fake daemon client (THE-2052), for
// test/room-live.test.tsx's browser half: `RoomView` on `useChat`, the client
// answering the room's requests and emitting the live frames the test hands it
// through `window.daemon`.
import type { ChatItem, ChatTurn, ProtocolEvent, ServerMessage } from "@armada/protocol";
import { LazyMotion, MotionConfig } from "motion/react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import features from "../src/components/shell/motion-features";
import { type ChatFrame, type DaemonClient, type DaemonState, initialState } from "../src/protocol/client";
import { DaemonProvider } from "../src/protocol/store";
import { useChat } from "../src/room/chat";
import { RoomView } from "../src/screens/Room";

const PROJECT = { id: "harbor", name: "Harbor", repository: "example/harbor" };
// The page's time stands where the test puts it (`daemon.setNow`): the Working row's timer reads it.
let now = Date.parse("2026-03-10T15:00:00.000Z");
Date.now = () => now;
const minor = Number(new URLSearchParams(location.search).get("minor") ?? "7");

const listeners = new Set<() => void>();
const frames = new Set<(frame: ChatFrame) => void>();
let state: DaemonState = { ...initialState, status: "live", projects: [PROJECT], minor };
let reading: { items: ChatItem[]; turn?: ChatTurn } = { items: [] };
let seq = 1;
const requests: Record<string, unknown>[] = [];
const set = (next: Partial<DaemonState>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};
/** A log holding one checkpoint at `seq`: the room reads the conversation again when it moves. */
const log = () => ({
  seq,
  events: [{ seq, kind: "coordinator.checkpoint", actor: "coordinator" } as unknown as ProtocolEvent],
});
set({ logs: { harbor: log() } });

const client: DaemonClient = {
  getState: () => state,
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  start() {},
  stop() {},
  login: async () => {
    throw new Error("Account is unavailable on this test page");
  },
  logout: async () => {
    throw new Error("Account is unavailable on this test page");
  },
  answer: () => {},
  cancel: async () => {},
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
  chat(listener) {
    frames.add(listener);
    return () => frames.delete(listener);
  },
  // biome-ignore lint/suspicious/noExplicitAny: the fake answers each request with its own reply type.
  async request(message): Promise<any> {
    requests.push({ ...message });
    const envelope = { version: { major: 1, minor }, id: `r${requests.length}`, project: PROJECT.id };
    switch (message.type) {
      case "chat.read":
        return {
          ...envelope,
          type: "chat.result",
          seq,
          coordinator: true,
          items: reading.items,
          ...(minor >= 7 && reading.turn ? { turn: reading.turn } : {}),
        } satisfies ServerMessage;
      case "chat.send":
        return { ...envelope, type: "chat.sent", requestId: message.requestId };
      case "chat.stop":
        return { ...envelope, type: "chat.stopped" };
      default:
        throw new Error(`not in this page: ${message.type}`);
    }
  },
};

(window as unknown as { daemon: unknown }).daemon = {
  requests,
  setNow(time: number) {
    now = time;
  },
  /** The next reading, the log unmoved: what the room reads when it asks on its own (after a Stop). */
  reading(items: ChatItem[], turn?: ChatTurn) {
    reading = { items, ...(turn ? { turn } : {}) };
  },
  /** One live frame, as the daemon would send it to a subscriber of CHAT_LIVE_MINOR; drawn before it returns. */
  emit(frame: Record<string, unknown>) {
    const full = { version: { major: 1, minor }, project: PROJECT.id, ...frame } as ChatFrame;
    flushSync(() => {
      for (const listener of frames) listener(full);
    });
  },
  /** A checkpoint: the next reading holds `items` (and `turn`), and the log moves past the last one. */
  checkpoint(items: ChatItem[], turn?: ChatTurn) {
    reading = { items, ...(turn ? { turn } : {}) };
    seq += 1;
    set({ logs: { harbor: log() } });
  },
};

function Live() {
  return (
    <RoomView
      project={PROJECT}
      snapshot={undefined}
      live
      now={Date.parse("2026-03-10T15:00:00.000Z")}
      zone="UTC"
      chat={useChat(PROJECT.id)}
    />
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <DaemonProvider client={client}>
      {/* The shell's motion, as the app gives every page. */}
      <MotionConfig reducedMotion="user">
        <LazyMotion features={features} strict>
          <Live />
        </LazyMotion>
      </MotionConfig>
    </DaemonProvider>,
  );
