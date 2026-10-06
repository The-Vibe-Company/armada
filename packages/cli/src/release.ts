// Ordinary releases are daily notices in status/inbox. Only required CLI or
// setup upgrades interrupt a watch. Versions come from the server's headers.
import {
  addNoticedRelease,
  compareVersions,
  entryKey,
  type InboxEntry,
  machinePaths,
  newerRelease,
  type RepoView,
  releaseEntry,
  releaseLine,
  skillsBehind,
  versionToInstall,
} from "@armada/core";
import { heard } from "./api.ts";
import type { Io } from "./io.ts";
import { fsRepoView } from "./repo.ts";

export const NOTICE_COMMANDS = new Set(["status", "inbox"]);
const NOTICE_MS = 24 * 60 * 60_000;

export async function noticeRelease(io: Io, running: string, view: RepoView = fsRepoView(io.cwd)): Promise<void> {
  const server = heard(io).server;
  if (io.env.ARMADA_TICKET?.trim() || !server || compareVersions(running, server.minimum) < 0) return;
  const latest = newerRelease(running, server.latest);
  const paths = machinePaths(io.env);
  // Without durable memory, a notice could repeat on every command.
  if (!latest || !paths) return;
  const setupBehind = (await skillsBehind(view)) !== null;
  const reserved = await addNoticedRelease(paths, latest, (io.now ?? (() => new Date()))(), {
    intervalMs: NOTICE_MS,
    pid: io.pid,
    alive: io.processAlive,
  }).catch(() => false);
  if (!reserved) return;
  io.stderr(`armada: ${releaseLine(running, latest, { setupBehind })}\n`);
}

/** Required changes are never suppressed by the daily notice. */
export function pendingRelease(
  io: Io,
  running: string,
  seen: readonly string[],
  view: RepoView = fsRepoView(io.cwd),
): () => Promise<InboxEntry | null> {
  return async () => {
    if (io.env.ARMADA_TICKET?.trim()) return null;
    const server = heard(io).server;
    const minimum = !!server && compareVersions(running, server.minimum) < 0;
    const behind = await skillsBehind(view);
    if (!minimum && !behind) return null;
    const latest =
      minimum && server
        ? versionToInstall(server.minimum, server.latest)
        : (newerRelease(running, server?.latest) ?? running);
    const entry = releaseEntry(running, latest, (io.now ?? (() => new Date()))(), {
      setupBehind: behind !== null,
      minimum: minimum && server ? server.minimum : null,
    });
    return !minimum && seen.includes(entryKey(entry)) ? null : entry;
  };
}
