// The notifications alone in a page (THE-2055), for test/notify.test.tsx's
// browser half: `Notifications` and the Settings switch on a fake daemon
// client that answers `chat.read` and emits the live frames the test hands
// it through `window.daemon`.
import type { ChatItem, ServerMessage } from "@armada/protocol";
import { LazyMotion, MotionConfig } from "motion/react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import features from "../src/components/shell/motion-features";
import { NotificationSetting } from "../src/notify/NotificationSetting";
import { Notifications } from "../src/notify/Notifications";
import { type ChatFrame, type DaemonClient, type DaemonState, initialState } from "../src/protocol/client";
import { DaemonProvider } from "../src/protocol/store";

const PROJECTS = [
  { id: "harbor", name: "Harbor", repository: "example/harbor" },
  { id: "lantern", name: "Lantern", repository: "example/lantern" },
];
const frames = new Set<(frame: ChatFrame) => void>();
const state: DaemonState = { ...initialState, status: "live", projects: PROJECTS, minor: 7 };
let reading: ChatItem[] = [];
let reads = 0;

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
  connectProvider: async () => {},
  answerProvider: () => {},
  cancelProvider: async () => {},
  disconnectProvider: async () => {},
  saveCredentials: async () => {},
  setPluginEnabled: async () => {},
  configurePlugin: async () => {},
  setPluginSecret: async () => {},
  restartDaemon: async () => {},
  chat(listener) {
    frames.add(listener);
    return () => frames.delete(listener);
  },
  // biome-ignore lint/suspicious/noExplicitAny: the fake answers the one request the notifier sends.
  async request(message): Promise<any> {
    if (message.type !== "chat.read") throw new Error(`not in this page: ${message.type}`);
    reads++;
    return {
      type: "chat.result",
      version: { major: 1, minor: 7 },
      id: "r1",
      project: message.project,
      seq: 1,
      coordinator: true,
      items: reading,
    } satisfies ServerMessage;
  },
};

(window as unknown as { daemon: unknown }).daemon = {
  /** The conversation the next `chat.read` answers. */
  reading(items: ChatItem[]) {
    reading = items;
  },
  /** How many times the notifier read a conversation. */
  get reads() {
    return reads;
  },
  /** One live frame, as the daemon sends it to a subscriber of CHAT_LIVE_MINOR. */
  emit(frame: Record<string, unknown>) {
    const full = { version: { major: 1, minor: 7 }, ...frame } as ChatFrame;
    flushSync(() => {
      for (const listener of frames) listener(full);
    });
  },
};

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <DaemonProvider client={client}>
      <MotionConfig reducedMotion="user">
        <LazyMotion features={features} strict>
          <NotificationSetting />
          <Notifications />
        </LazyMotion>
      </MotionConfig>
    </DaemonProvider>,
  );
