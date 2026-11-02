// The room alone in a page on a fake daemon (THE-2128), for
// test/room-model.test.tsx: `RoomView` on `useChat`, pi's catalog with two
// connected providers and one that is not, the client's `select` answering as
// the daemon does (the shared selection, or the project's own model when its
// rules name one), and the live turn frames the test hands it through
// `window.daemon`. `?override=1` gives the project its own model; `?minor=`
// the daemon's protocol minor.
import type { ChatItem, ModelsCatalog, ProtocolEvent, ServerMessage } from "@armada/protocol";
import { LazyMotion, MotionConfig } from "motion/react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import features from "../src/components/shell/motion-features";
import { type ChatFrame, type DaemonClient, type DaemonState, initialState } from "../src/protocol/client";
import { DaemonProvider, useDaemon } from "../src/protocol/store";
import { useChat } from "../src/room/chat";
import { RoomView } from "../src/screens/Room";

const PROJECT = { id: "harbor", name: "Harbor", repository: "example/harbor" };
const T0 = Date.parse("2026-03-10T15:00:00.000Z");
let now = T0;
Date.now = () => now;
const search = new URLSearchParams(location.search);
const minor = Number(search.get("minor") ?? "24");
const override = search.get("override") === "1";

type Provider = ModelsCatalog["providers"][number];
const model = (id: string, name: string, reasoning = false) => ({
  id,
  name,
  reasoning,
  contextWindow: 200_000,
  inputCost: 1,
  outputCost: 2,
});
const provider = (id: string, name: string, status: Provider["status"], models: Provider["models"]): Provider => ({
  id,
  name,
  auth: { oauth: true, apiKey: true, envVars: [] },
  status,
  models,
});
const providers: Provider[] = [
  provider("anthropic", "Anthropic", "signed-in", [
    model("claude-keel", "Claude Keel", true),
    model("claude-skiff", "Claude Skiff"),
  ]),
  provider("openai-codex", "ChatGPT", "signed-in", [model("codex-mini", "Codex Mini")]),
  provider("groq", "Groq", "unconfigured", [model("llama-dory", "Llama Dory")]),
];

const listeners = new Set<() => void>();
const frames = new Set<(frame: ChatFrame) => void>();
let rules: { revision: number; value: { coordinatorModel?: { provider: string; model: string } } } = override
  ? { revision: 1, value: { coordinatorModel: { provider: "anthropic", model: "claude-skiff" } } }
  : { revision: 0, value: {} };
const snapshot = () => ({ seq: 1, state: { rules } });
let state: DaemonState = {
  ...initialState,
  status: "live",
  projects: [PROJECT],
  minor,
  catalog: { providers, selected: { provider: "anthropic", model: "claude-keel" } },
};
const requests: Record<string, unknown>[] = [];
const set = (next: Partial<DaemonState>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};
const log = () => ({
  seq: 1,
  events: [{ seq: 1, kind: "coordinator.checkpoint", actor: "coordinator" } as unknown as ProtocolEvent],
});
set({ logs: { harbor: log() }, fleets: { harbor: snapshot() } });
const items: ChatItem[] = [
  { kind: "owner", id: "e1", at: new Date(T0 - 60_000).toISOString(), body: "Triage the new tickets." },
  { kind: "coordinator", id: "e2", at: new Date(T0 - 30_000).toISOString(), body: "Three tickets triaged." },
];

const refuse = async () => {
  throw new Error("Outside this page");
};
const client: DaemonClient = {
  getState: () => state,
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  start() {},
  stop() {},
  login: refuse,
  logout: refuse,
  answer: () => {},
  cancel: async () => {},
  // As the daemon: the project's own model when its rules name one, else the shared selection.
  async select(provider, model, project) {
    requests.push({ type: "models.select", provider, model, ...(project ? { project } : {}) });
    if (project && rules.value.coordinatorModel) {
      rules = { revision: rules.revision + 1, value: { ...rules.value, coordinatorModel: { provider, model } } };
      set({ fleets: { harbor: snapshot() } });
    } else if (state.catalog) set({ catalog: { ...state.catalog, selected: { provider, model } } });
  },
  auth: () => () => {},
  connectProvider: refuse,
  answerProvider: () => {},
  cancelProvider: async () => {},
  disconnectProvider: refuse,
  inspectProject: refuse,
  addProject: refuse,
  removeProject: refuse,
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
    const envelope = { version: { major: 1, minor }, id: "r", project: PROJECT.id };
    switch (message.type) {
      case "chat.read":
        return { ...envelope, type: "chat.result", seq: 1, coordinator: true, items } satisfies ServerMessage;
      case "chat.send":
        return { ...envelope, type: "chat.sent", requestId: message.requestId };
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
  /** A live turn frame, drawn before it returns. */
  emit(frame: Record<string, unknown>) {
    const full = { version: { major: 1, minor }, project: PROJECT.id, ...frame } as ChatFrame;
    flushSync(() => {
      for (const listener of frames) listener(full);
    });
  },
};

function Room() {
  const { fleets } = useDaemon();
  return <RoomView project={PROJECT} snapshot={fleets.harbor} live now={T0} zone="UTC" chat={useChat(PROJECT.id)} />;
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <DaemonProvider client={client}>
      <MotionConfig reducedMotion="user">
        <LazyMotion features={features} strict>
          <Room />
        </LazyMotion>
      </MotionConfig>
    </DaemonProvider>,
  );
