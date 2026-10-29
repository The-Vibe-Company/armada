import { projectSchema } from "@armada/protocol";
import { GithubReader } from "../forge/github.ts";
import { type Schedule, schedule } from "../forge/types.ts";
import { githubToken, readLinearKey, type SecretAccessor, systemKeychain } from "../keychain.ts";
import type { EventStore } from "../store.ts";
import { linearTracker, TrackerPoller } from "../tracker/index.ts";

/** Daemon-only catalog fields; the public project protocol remains unchanged. */
export const daemonProjectSchema = projectSchema.extend({
  programRoot: projectSchema.shape.id.optional(),
  phaseGroup: projectSchema.shape.name.default("Agent phase"),
});
type ReaderProject = { id: string; name: string; repository: string; programRoot?: string; phaseGroup?: string };
interface ReaderOptions {
  store: EventStore;
  projects: readonly ReaderProject[];
  secrets?: SecretAccessor;
  token?: (signal: AbortSignal) => Promise<string>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  schedule?: Schedule;
  log?: (line: string) => void;
  signal?: AbortSignal;
}
export interface ReaderState {
  project: string;
  tracker: boolean;
  forge: boolean;
}

/** Boot's sole reader composition point, to be replaced by the plugin registry.
 * Credential preflight is independent of reads; no provider request delays readiness.
 * Environment overrides and the shared keychain remain host-owned sources.
 */
export async function startReaders(options: ReaderOptions): Promise<{ readers: ReaderState[]; stop(): void }> {
  const projects = options.projects.map((project) => daemonProjectSchema.parse(project));
  const now = options.now ?? (() => new Date());
  const set = options.schedule ?? schedule;
  const fetch = options.fetch ?? globalThis.fetch;
  const secrets: SecretAccessor =
    options.secrets ??
    (async (service, account) => process.env.LINEAR_API_KEY?.trim() || systemKeychain().read(service, account));
  const token =
    options.token ?? (async (signal: AbortSignal) => process.env.GITHUB_TOKEN?.trim() || githubToken({ signal }));
  const log = options.log ?? console.error;
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
  try {
    for (const project of projects) {
      if (stopped) break;
      // Catalog names must not create extra stderr lines or terminal controls.
      const logProject = project.id.replace(
        /[\p{Cc}\p{Zl}\p{Zp}]/gu,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
      const state: ReaderState = { project: project.id, tracker: false, forge: false };
      readers.push(state);
      if (project.programRoot) {
        let available = false;
        try {
          await readLinearKey(secrets, project.id);
          available = true;
        } catch {
          /* Safe fixed diagnostic below. */
        }
        if (stopped) break;
        if (available) {
          const tracker = linearTracker({
            project: project.id,
            rootId: project.programRoot,
            phaseGroup: project.phaseGroup,
            secrets,
            fetch,
            now,
          });
          const poller = new TrackerPoller({ project: project.id, tracker, store: options.store, clock: { now, set } });
          stops.push(() => poller.stop());
          poller.start();
          state.tracker = true;
        } else log(`armadad: ${logProject}: tracker skipped (Linear key unavailable)`);
      }
      let available = false;
      try {
        available = Boolean((await token(options.signal ?? new AbortController().signal)).trim());
      } catch {
        /* Never log credential errors. */
      }
      if (stopped) break;
      if (available) {
        const forge = new GithubReader({
          project: project.id,
          repository: project.repository,
          actor: "owner",
          store: options.store,
          tickets: () =>
            new Set(
              options.store
                .readSince(0, project.id)
                .flatMap((event) => (event.kind === "ticket.seen" ? [event.payload.id] : [])),
            ),
          token,
          fetch,
          now,
          schedule: set,
        });
        stops.push(() => forge.stop());
        forge.start();
        state.forge = true;
      } else log(`armadad: ${logProject}: forge skipped (GitHub key unavailable)`);
    }
    return { readers, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
