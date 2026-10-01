// A newer Armada is out: a coordinator command says so once per version on
// this machine (remembered in `releases.json` of the machine store), and
// `armada watch` ends on it as a `version` item. The latest version is what
// the server said in its answers (`x-armada-cli-latest`): no call to npm.
import {
  addNoticedRelease,
  compareVersions,
  type InboxEntry,
  machinePaths,
  newerRelease,
  readNoticedReleases,
  releaseEntry,
  releaseLine,
} from "@armada/core";
import { heard } from "./api.ts";
import type { Io } from "./io.ts";

/** The commands a coordinator runs, which carry the notice. */
export const NOTICE_COMMANDS = new Set(["status", "inbox", "watch", "brief", "merge", "doctor"]);

/**
 * The release newer than `running` this run heard of; null for a worker (its
 * session signed the run in, or its launch set ARMADA_TICKET: it installs the
 * version its brief names), or when this CLI is older than the server's
 * minimum (the upgrade line already says what to install).
 */
function newer(io: Io, running: string): string | null {
  const h = heard(io);
  if (h.worker || io.env.ARMADA_TICKET?.trim() || !h.server || compareVersions(running, h.server.minimum) < 0)
    return null;
  return newerRelease(running, h.server.latest);
}

/** The releases this machine's coordinator was already told of; none without a machine store. */
export async function noticedReleases(io: Io): Promise<Set<string>> {
  const paths = machinePaths(io.env);
  return new Set(paths ? await readNoticedReleases(paths).catch(() => []) : []);
}

/** Remembers that the coordinator was told of `version`, best effort: at worst it is told again. */
export async function rememberRelease(io: Io, version: string): Promise<void> {
  const paths = machinePaths(io.env);
  if (paths) await addNoticedRelease(paths, version).catch(() => {});
}

/** After a coordinator command: one line on stderr for a release not noticed yet on this machine. */
export async function noticeRelease(io: Io, running: string): Promise<void> {
  const latest = newer(io, running);
  if (!latest || (await noticedReleases(io)).has(latest)) return;
  io.stderr(`armada: ${releaseLine(running, latest)}\n`);
  await rememberRelease(io, latest);
}

/** For `armada watch`: the `version` entry of a release not noticed yet, asked after every read. */
export function pendingRelease(io: Io, running: string, noticed: Set<string>): () => InboxEntry | null {
  return () => {
    const latest = newer(io, running);
    return latest && !noticed.has(latest) ? releaseEntry(running, latest, (io.now ?? (() => new Date()))()) : null;
  };
}
