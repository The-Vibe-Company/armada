import type { NodeProvider, PluginManifest, RuntimeProvider, WorkerObservation, WorkerRef } from "@armada/plugin-api";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import type { EventStore } from "../../src/store.ts";
import { Workers } from "../../src/workers/service.ts";

// A live worker on a fake runtime and node (no process, no worktree), launched
// through the daemon's real `Workers`: the launch, its generation fence, the
// keyed deliveries and the stop are the daemon's own; only the native side is
// recorded. For tests and the app's dev daemon.

export interface FakeRuntime {
  /** Every message delivered, the brief first, with its key. */
  delivered: { session: string; key: string; message: string }[];
  stopped: WorkerRef[];
  disposed: string[];
  /** What `observe` answers as the worker's output, by session. */
  output: Map<string, string>;
}

const MANIFEST = {
  contributions: { runtime: { claude: {} }, node: { local: {} }, tracker: {}, forge: {}, model: {} },
} as unknown as PluginManifest;

export function fakeWorkers(store: EventStore, projects: { id: string; repository: string }[]) {
  const fake: FakeRuntime = { delivered: [], stopped: [], disposed: [], output: new Map() };
  const tokens = new Map<string, string>();
  const running = new Set<string>();
  const node: NodeProvider = {
    prepare: async (r) => ({ id: `${r.project}/${r.ticket}`, path: `/fake/${r.ticket}`, node: "local" }),
    launch: async () => {
      throw new Error("The fake runtime launches");
    },
    deliver: async () => {},
    observe: async () => ({ state: "unknown" }),
    stop: async () => {},
    dispose: async (workspace) => {
      fake.disposed.push(workspace.id);
    },
  };
  const runtime: RuntimeProvider = {
    withNode: () => runtime,
    prepare: (r) => node.prepare(r),
    async launch(request) {
      const ref = { ...request.worker, handle: `fake-${request.worker.session}` };
      tokens.set(ref.session, request.env.ARMADA_WORKER_TOKEN ?? "");
      running.add(ref.session);
      return ref;
    },
    async deliver(ref, message, key) {
      fake.delivered.push({ session: ref.session, key, message });
    },
    async observe(ref): Promise<WorkerObservation> {
      const output = fake.output.get(ref.session);
      return {
        state: running.has(ref.session) ? "running" : "stopped",
        activity: running.has(ref.session) ? "working" : "idle",
        ...(output === undefined ? {} : { reply: output }),
      };
    },
    async stop(ref) {
      running.delete(ref.session);
      fake.stopped.push(ref);
    },
  };
  const registry = new PluginRegistry();
  const activation = registry.activation(MANIFEST);
  activation.register.runtime("claude", runtime);
  activation.register.node("local", node);
  activation.commit();
  const workers = new Workers({
    store,
    registry,
    socketPath: "/fake/worker.sock",
    projects: projects.map((p) => ({ ...p, checkout: `/fake/${p.id}` })),
  });
  let calls = 0;
  return {
    workers,
    fake,
    /** Launches the ticket (ready for an agent, in the log) and has its worker claim it; returns its token. */
    async launch(project: string, ticket: string) {
      const launched = await workers.tool(project, "worker.launch", { ticket }, `fake-launch-${++calls}`, () => {});
      const session = String(launched.session);
      const token = tokens.get(session) ?? "";
      await workers.request(token, { command: "claim", ticket });
      return {
        session,
        generation: Number(launched.generation),
        token,
        ask: (question: string) => workers.request(token, { command: "ask", ticket, question, key: question }),
      };
    },
  };
}
