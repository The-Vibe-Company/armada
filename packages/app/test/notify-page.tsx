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
/** The toasts' clock, turned by the test: `daemon.elapse(ms)`. */
let now = 0;
const due = new Map<number, { at: number; run: () => void }>();
let next = 0;
const schedule = (run: () => void, ms: number) => {
  const id = ++next;
  due.set(id, { at: now + ms, run });
  return () => void due.delete(id);
};

const client: DaemonClient = {
  getState: () => state,
  subscribe: () => () => {},
  start() {},
  stop() {},
  login: async () => {
    throw new Error("Account is unavailable on this test page");
  },
  logout: async () => {
    throw new Error("Account is unavailable on this test page");
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
  /** The toasts' timers waiting to run. */
  get pending() {
    return due.size;
  },
  /** The toasts' time moves on by `ms`; what falls due runs, drawn before it returns. */
  elapse(ms: number) {
    now += ms;
    flushSync(() => {
      for (const [id, timer] of [...due]) {
        if (timer.at > now) continue;
        due.delete(id);
        timer.run();
      }
    });
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
          <Notifications schedule={schedule} />
        </LazyMotion>
      </MotionConfig>
    </DaemonProvider>,
  );
