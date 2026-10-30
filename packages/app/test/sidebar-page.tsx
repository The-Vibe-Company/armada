// The sidebar alone in a page on a fake daemon client (THE-2054), for
// test/sidebar.test.tsx: two projects whose conversations the test hands it
// (`window.READINGS`), their coordinators' turns through `window.daemon`.
import type { ChatItem, ProtocolEvent, ServerMessage } from "@armada/protocol";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../src/components/shell/Sidebar";
import { type ChatFrame, type DaemonClient, type DaemonState, initialState } from "../src/protocol/client";
import { DaemonProvider } from "../src/protocol/store";

const readings = (window as unknown as { READINGS: Record<string, ChatItem[]> }).READINGS;
const projects = Object.keys(readings).map((id) => ({
  id,
  name: id[0]?.toUpperCase() + id.slice(1),
  repository: `example/${id}`,
}));
const frames = new Set<(frame: ChatFrame) => void>();
const listeners = new Set<() => void>();
/** Each project's log holds one coordinator checkpoint: the sidebar reads its conversation once. */
const log = {
  seq: 1,
  events: [{ seq: 1, kind: "coordinator.checkpoint", actor: "coordinator" } as unknown as ProtocolEvent],
};
const state: DaemonState = {
  ...initialState,
  status: "live",
  minor: 7,
  projects: projects as DaemonState["projects"],
  logs: Object.fromEntries(projects.map((p) => [p.id, log])),
};

const client: DaemonClient = {
  getState: () => state,
  subscribe(listener) {
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
    if (message.type !== "chat.read") throw new Error(`not in this page: ${message.type}`);
    return {
      version: { major: 1, minor: 7 },
      id: "r",
      type: "chat.result",
      project: message.project,
      seq: 1,
      coordinator: true,
      items: readings[message.project] ?? [],
    } satisfies ServerMessage;
  },
};

(window as unknown as { daemon: unknown }).daemon = {
  /** One live frame of a project's coordinator; drawn before it returns. */
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
      <Sidebar />
    </DaemonProvider>,
  );
