import { readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  Harness,
  type HarnessOptions,
  type ModelRef,
  section,
} from "@earendil-works/pi-durable";
import type { EventStore } from "../src/store.ts";
import { type NativeToolOptions, nativeTools } from "./native.ts";
import { openCoordinatorStorage } from "./storage.ts";
import { type CoordinatorTools, coordinatorTools } from "./tools.ts";

export { type MergeEvidence, type NativeToolOptions, nativeTools } from "./native.ts";
export { openCoordinatorStorage } from "./storage.ts";
export { type CoordinatorToolName, type CoordinatorTools, coordinatorTools, TOOL_NAMES } from "./tools.ts";

export const SYSTEM_PROMPT = readFileSync(new URL("./system.md", import.meta.url), "utf8");

export interface CoordinatorOptions {
  project: string;
  /** A caller-owned pi-ai SDK instance. No provider creation or credential lookup occurs here. */
  models: HarnessOptions["models"];
  model: ModelRef;
  tools?: CoordinatorTools;
  /** Optional read adapters for facts the folded fleet cannot establish. */
  native?: Omit<NativeToolOptions, "now">;
  now?: () => number;
  setTimer?: HarnessOptions["setTimer"];
  onReport?: HarnessOptions["onReport"];
}
export interface ProjectCoordinator {
  harness: Harness;
  conversation: Conversation;
}

/** Daemon-owned lifetime: one durable root conversation and scheduler per project. */
export class Coordinators {
  readonly #store: EventStore;
  readonly #projects = new Map<string, Promise<ProjectCoordinator>>();
  #closed = false;

  constructor(store: EventStore) {
    this.#store = store;
  }

  open(options: CoordinatorOptions): Promise<ProjectCoordinator> {
    if (this.#closed) return Promise.reject(new Error("Coordinators are closed"));
    const existing = this.#projects.get(options.project);
    if (existing) return existing;
    const pending = this.#open(options);
    this.#projects.set(options.project, pending);
    void pending.catch(() => this.#projects.delete(options.project));
    return pending;
  }

  async #open(options: CoordinatorOptions): Promise<ProjectCoordinator> {
    const now = options.now ?? Date.now;
    const storage = openCoordinatorStorage({
      store: this.#store,
      project: options.project,
      now: () => new Date(now()).toISOString(),
    });
    let harness: Harness | undefined;
    try {
      const registry = createRegistry();
      registry.install(
        defineExtension({
          name: "armada.coordinator",
          tools: coordinatorTools({
            ...nativeTools(storage, { ...options.native, now: () => new Date(now()).toISOString() }),
            ...options.tools,
          }),
          sections: [section("armada_coordinator", () => SYSTEM_PROMPT, { tag: false })],
        }),
      );
      harness = await Harness.open(
        storage,
        {
          models: options.models,
          registry,
          now,
          setTimer: options.setTimer,
          onReport: options.onReport,
          settings: { toolExecution: "sequential" },
        },
        BACKGROUND_CONTEXT,
      );
      const conversation = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: options.model },
      });
      const current = (await conversation.agent(BACKGROUND_CONTEXT)).model;
      if (current?.provider !== options.model.provider || current?.modelId !== options.model.modelId)
        await conversation.configure({ model: options.model }, BACKGROUND_CONTEXT);
      harness.resume();
      return { harness, conversation };
    } catch (error) {
      if (harness) await harness.close(BACKGROUND_CONTEXT);
      else await storage.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  /** Stop schedulers before the daemon closes its shared store. Pending work remains resumable. */
  async close(): Promise<void> {
    this.#closed = true;
    const results = await Promise.allSettled(
      [...this.#projects.values()].map(async (pending) => {
        const coordinator = await pending;
        await coordinator.harness.close(BACKGROUND_CONTEXT);
      }),
    );
    this.#projects.clear();
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
