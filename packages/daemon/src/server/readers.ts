import { projectSchema } from "@armada/protocol";
import { z } from "zod";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { EventStore } from "../store.ts";

/** Catalog selection is host-owned; provider configuration belongs to each plugin. */
export const daemonProjectSchema = projectSchema.extend({
  // Model validation belongs to coordinator boot, so readers survive a bad selection.
  coordinatorModel: z.unknown().optional(),
  programRoot: projectSchema.shape.id.optional(),
  phaseGroup: projectSchema.shape.name.default("Agent phase"),
  tracker: projectSchema.shape.id.default("linear"),
  forge: projectSchema.shape.id.default("github"),
});
type ReaderProject = {
  id: string;
  name: string;
  repository: string;
  programRoot?: string;
  phaseGroup?: string;
  tracker?: string;
  forge?: string;
};
type Schedule = (callback: () => void, milliseconds: number) => () => void;
interface ReaderOptions {
  registry: Pick<PluginRegistry, "get">;
  projects: readonly ReaderProject[];
  store?: Pick<EventStore, "append">;
  now?: () => string;
  schedule?: Schedule;
  log?: (line: string) => void;
  signal?: AbortSignal;
}
export interface ReaderState {
  project: string;
  tracker: boolean;
  forge: boolean;
}
const schedule: Schedule = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

/** Independent background consumers; coordinator reads can request one bounded refresh. */
export async function startReaders(
  options: ReaderOptions,
): Promise<{ readers: ReaderState[]; refresh(project: string): Promise<void>; stop(): void }> {
  const projects = options.projects.map((project) => daemonProjectSchema.parse(project));
  const set = options.schedule ?? schedule;
  const stops: (() => void)[] = [];
  const readers: ReaderState[] = [];
  const refreshers = new Map<string, { read(): Promise<void>; abort(): void }[]>();
  const waiting = new Set<() => void>();
  let stopped = false;
  const stop = () => {
    stopped = true;
    options.signal?.removeEventListener("abort", stop);
    for (const cancel of stops.splice(0)) cancel();
    for (const finish of waiting) finish();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  for (const project of projects) {
    const state: ReaderState = { project: project.id, tracker: false, forge: false };
    readers.push(state);
    const sources: { read(): Promise<void>; abort(): void }[] = [];
    refreshers.set(project.id, sources);
    if (stopped) continue;
    for (const seam of ["tracker", "forge"] as const) {
      const provider = options.registry.get(seam, project[seam]);
      if (!provider) continue;
      state[seam] = true;
      let cancelNext: (() => void) | undefined;
      let cancelDeadline: (() => void) | undefined;
      let active: AbortController | undefined;
      let running = true;
      stops.push(() => {
        running = false;
        cancelNext?.();
        cancelDeadline?.();
        active?.abort();
      });
      let pending: Promise<void> | undefined;
      const tick = (): Promise<void> => {
        if (pending) return pending;
        if (!running) return Promise.resolve();
        cancelNext?.();
        cancelNext = undefined;
        const controller = new AbortController();
        active = controller;
        const cancelReadDeadline = set(() => controller.abort(), 30_000);
        cancelDeadline = cancelReadDeadline;
        pending = Promise.resolve().then(async () => {
          try {
            // Await settlement even after abort: an uncooperative plugin must not accumulate reads.
            await provider.read({ project: project.id, signal: controller.signal });
            if (running && !controller.signal.aborted)
              options.store?.append({
                project: project.id,
                kind: "coordinator.checkpoint",
                actor: "reader",
                at: (options.now ?? (() => new Date().toISOString()))(),
                payload: { checkpoint: { format: "armada.readers", version: 1, provider: project[seam] } },
              });
          } catch {
            if (running) {
              const id = project.id.replace(
                /[\p{Cc}\p{Zl}\p{Zp}]/gu,
                (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
              );
              (options.log ?? console.error)(`armadad: ${id}: ${seam} read failed`);
            }
          } finally {
            cancelReadDeadline();
            cancelDeadline = undefined;
            active = undefined;
            pending = undefined;
            if (running)
              cancelNext = set(() => {
                void tick();
              }, 30_000);
          }
        });
        return pending;
      };
      sources.push({ read: tick, abort: () => active?.abort() });
      // Start independently of boot readiness and of the other seam.
      void Promise.resolve().then(tick);
    }
  }
  return {
    readers,
    stop,
    async refresh(project) {
      const sources = refreshers.get(project);
      if (stopped || !sources?.length) return;
      // Race the caller separately from provider settlement. An ignoring plugin stays
      // single-flight, but can never hold a model turn open past this deadline.
      await new Promise<void>((resolve) => {
        let cancel: (() => void) | undefined;
        const finish = () => {
          cancel?.();
          waiting.delete(finish);
          resolve();
        };
        waiting.add(finish);
        cancel = set(() => {
          for (const source of sources) source.abort();
          finish();
        }, 3000);
        void Promise.all(sources.map((source) => source.read())).then(finish, finish);
      });
    },
  };
}
