import { projectSchema } from "@armada/protocol";
import { z } from "zod";
import type { PluginRegistry } from "../plugins/registry.ts";

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

/** Independent background consumers. Request handlers only read the committed log. */
export async function startReaders(options: ReaderOptions): Promise<{ readers: ReaderState[]; stop(): void }> {
  const projects = options.projects.map((project) => daemonProjectSchema.parse(project));
  const set = options.schedule ?? schedule;
  const stops: (() => void)[] = [];
  const readers: ReaderState[] = [];
  let stopped = false;
  const stop = () => {
    stopped = true;
    options.signal?.removeEventListener("abort", stop);
    for (const cancel of stops.splice(0)) cancel();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  for (const project of projects) {
    const state: ReaderState = { project: project.id, tracker: false, forge: false };
    readers.push(state);
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
      const tick = async () => {
        if (!running) return;
        const controller = new AbortController();
        active = controller;
        const cancelReadDeadline = set(() => controller.abort(), 30_000);
        cancelDeadline = cancelReadDeadline;
        try {
          // Await settlement even after abort: an uncooperative plugin must not accumulate reads.
          await provider.read({ project: project.id, signal: controller.signal });
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
          if (running)
            cancelNext = set(() => {
              void tick();
            }, 30_000);
        }
      };
      // Start independently of boot readiness and of the other seam.
      void Promise.resolve().then(tick);
    }
  }
  return { readers, stop };
}
