// Ordinary releases are daily notices in status/inbox. Only required CLI
// upgrades interrupt a watch. Versions come from the server's headers.
import {
  addNoticedRelease,
  compareVersions,
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

export async function noticeRelease(
  io: Io,
  running: string,
  view: RepoView = fsRepoView(io.cwd),
  options: { setupOnly?: boolean } = {},
): Promise<void> {
  const server = heard(io).server;
  if (io.env.ARMADA_TICKET?.trim() || (server && compareVersions(running, server.minimum) < 0)) return;
  const paths = machinePaths(io.env);
  // Without durable memory, a notice could repeat on every command.
  if (!paths) return;
  const newer = newerRelease(running, server?.latest);
  const setupBehind = (await skillsBehind(view)) !== null;
  if ((!newer || options.setupOnly) && !setupBehind) return;
  const latest = newer ?? running;
  const reserved = await addNoticedRelease(
    paths,
    setupBehind ? `setup:${latest}` : latest,
    (io.now ?? (() => new Date()))(),
    {
      intervalMs: NOTICE_MS,
      pid: io.pid,
      alive: io.processAlive,
    },
  ).catch(() => false);
  if (!reserved) return;
  io.stderr(`armada: ${releaseLine(running, latest, { setupBehind })}\n`);
}

/** Required changes are never suppressed by the daily notice. */
export function pendingRelease(io: Io, running: string): () => Promise<InboxEntry | null> {
  return async () => {
    if (io.env.ARMADA_TICKET?.trim()) return null;
    const server = heard(io).server;
    if (!server || compareVersions(running, server.minimum) >= 0) return null;
    return releaseEntry(running, versionToInstall(server.minimum, server.latest), (io.now ?? (() => new Date()))(), {
      minimum: server.minimum,
    });
  };
}
