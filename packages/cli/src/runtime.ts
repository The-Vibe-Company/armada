// Local observations travel through the same project-scoped fleet API as claims.
// Herdr is read only on the coordinator's machine; dashboard reads Postgres.
import type { ArmadaConfig, Credentials, Fleet, RuntimeHandle } from "@armada/core";
import { Refusal } from "@armada/core";
import { Herdr, HerdrError, parseHerdrHandle } from "./herdr.ts";
import type { Io } from "./io.ts";
import { requireSignIn } from "./login.ts";
import { liveFleet, type WorkerArgs } from "./worker.ts";

export const isHerdr = (runtime: string) => runtime.toLowerCase() === "herdr";

/** New coordinators discover workers from claims, never process-local memory. */
export async function observeHerdr(io: Io, fleet: Fleet): Promise<RuntimeHandle[]> {
  const handles = await fleet.runtimeHandles();
  const local = handles.filter((h) => isHerdr(h.runtime));
  if (!local.length) return handles;
  await Promise.all(
    local.map(async (h) => {
      try {
        await verifyProvenance(io, h);
        const reading = await new Herdr(io).reading(parseHerdrHandle(h.handle));
        await fleet.observeRuntime({ ticket: h.ticket, handle: h.handle, claimedAt: h.claimedAt, ...reading });
      } catch {
        // A claim can belong to another machine. Keep its last observation until
        // the server's freshness window expires; do not invent a local state.
      }
    }),
  );
  return fleet.runtimeHandles();
}

/** Each inbox poll refreshes observations, including watch and inbox --wait. */
export function observingFleet(io: Io, fleet: Fleet): Fleet {
  return {
    ...fleet,
    inbox: async (query) => {
      try {
        await observeHerdr(io, fleet);
      } catch {}
      return fleet.inbox(query);
    },
  };
}

/** Core has already completed all answer refusal checks when this hook runs. */
export async function deliverHerdr(
  io: Io,
  fleet: Fleet,
  ticket: string,
  text: string,
  expected?: RuntimeHandle | null,
): Promise<boolean> {
  const h = await fleet.runtimeHandle(ticket);
  if (!h || !isHerdr(h.runtime)) return false;
  if (!expected || h.handle !== expected.handle || h.claimedAt !== expected.claimedAt)
    throw new Refusal(`${ticket}'s claim changed before delivery; no answer was delivered`, "armada inbox");
  if (h.releasedAt) throw new Refusal(`${ticket}'s herdr worker has ended; no answer was delivered`, "armada status");
  await verifyProvenance(io, h);
  const current = await fleet.runtimeHandle(ticket);
  if (!current || current.handle !== h.handle || current.claimedAt !== h.claimedAt || current.releasedAt)
    throw new Refusal(`${ticket}'s claim changed before delivery; no answer was delivered`, "armada inbox");
  await new Herdr(io).message(parseHerdrHandle(h.handle), text);
  return true;
}

/** IDs can be reused by a reset server; bind them to the claimed repository and branch. */
async function verifyProvenance(io: Io, h: RuntimeHandle): Promise<void> {
  const tree = await new Herdr(io).worktree(parseHerdrHandle(h.handle));
  const git = async (cwd: string, args: string[]) => {
    const result = await io.exec?.("git", args, { cwd, timeoutMs: 5_000 });
    if (result?.code !== 0) throw new Refusal("could not verify the herdr claim repository", "armada status");
    return result.stdout.trim();
  };
  const commonArgs = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
  const local = await git(io.cwd, commonArgs);
  const worker = await git(tree.path, commonArgs);
  if (!local || local !== worker || !h.branch || (await git(tree.path, ["branch", "--show-current"])) !== h.branch)
    throw new Refusal("herdr workspace does not match the claimed repository and branch", "armada status");
}

export async function stop(io: Io, config: ArmadaConfig, credentials: Credentials, args: WorkerArgs) {
  const [raw, ...extra] = args.rest;
  if (!raw || extra.length) throw new Refusal("stop needs one ticket: armada stop <ticket>", "armada stop --help");
  requireSignIn(credentials);
  const { fleet } = liveFleet(io, config, credentials);
  if (!fleet) throw new Refusal("stop needs Armada's stored claim", "armada whoami");
  const ticket = raw.toUpperCase();
  const h = await fleet.runtimeHandle(ticket);
  if (!h || !isHerdr(h.runtime)) throw new Refusal(`${ticket} has no herdr claim to stop`, "armada status");
  const handle = parseHerdrHandle(h.handle);
  const runtime = new Herdr(io);
  let tree: { repo: string; path: string };
  try {
    tree = await runtime.worktree(handle);
  } catch (error) {
    // A prior removal may have succeeded before its fleet write failed. Only
    // the server's explicit missing-workspace result permits this recovery.
    if (!(error instanceof HerdrError) || error.code !== "workspace_not_found") throw error;
    if (!(await fleet.stopRuntime({ ticket, handle: h.handle, claimedAt: h.claimedAt })))
      throw new Refusal("claim changed during archive recovery", "armada status");
    io.stdout(
      args.json
        ? `${JSON.stringify({ ticket, stopped: true, alreadyAbsent: true })}\n`
        : `${ticket}'s herdr workspace is already absent; its claim is ended.\n`,
    );
    return 0;
  }
  const git = async (cwd: string, argv: string[]) => {
    const r = await io.exec?.("git", argv, { cwd, timeoutMs: 30_000 });
    if (r?.code !== 0)
      throw new Refusal(
        "could not verify the worker's Git state; left its worktree untouched",
        `git -C ${tree.path} status`,
      );
    return r.stdout.trim();
  };
  // Bind the workspace's provenance to this repository and this claim's branch.
  const localCommon = await git(io.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const treeCommon = await git(tree.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const branch = await git(tree.path, ["branch", "--show-current"]);
  if (localCommon !== treeCommon || !h.branch || branch !== h.branch)
    throw new Refusal(
      "herdr worktree does not match this repository and claim branch; left it untouched",
      "herdr worktree list",
    );
  const dirty = await git(tree.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty)
    throw new Refusal(`cannot stop ${ticket}: uncommitted work remains:\n${dirty}`, `git -C ${tree.path} status`);
  // Refresh exactly the configured upstream. A cached tracking ref alone does
  // not prove that work is still on the remote. No broad fetch or shell input.
  const upstream = await git(tree.path, [
    "for-each-ref",
    "--format=%(upstream:remotename)%00%(upstream:remoteref)",
    `refs/heads/${branch}`,
  ]);
  const [remote, ref] = upstream.split("\0");
  if (!remote || remote === "." || remote.startsWith("-") || !ref?.startsWith("refs/heads/"))
    throw new Refusal(
      `cannot stop ${ticket}: the branch has no verified remote upstream`,
      `git -C ${tree.path} push -u origin ${branch}`,
    );
  const advertised = await git(tree.path, ["ls-remote", "--exit-code", "--heads", "--", remote, ref]);
  const [remoteHead, remoteRef] = advertised.split("\t");
  if (!/^[a-f0-9]{40,64}$/.test(remoteHead ?? "") || remoteRef !== ref)
    throw new Refusal(`cannot stop ${ticket}: could not verify the upstream head`, `git -C ${tree.path} fetch`);
  // FETCH_HEAD is shared by every checkout. Pin the advertised commit instead
  // so another worker's fetch cannot change which history we compare against.
  await git(tree.path, ["fetch", "--no-tags", "--no-write-fetch-head", "--", remote, ref]);
  const localHead = await git(tree.path, ["rev-parse", "HEAD"]);
  const left = await git(tree.path, ["log", "--format=%h %s", `${remoteHead}..${localHead}`]);
  if (left) throw new Refusal(`cannot stop ${ticket}: unpushed commits remain:\n${left}`, `git -C ${tree.path} push`);
  // Cancel a running turn and wait for a confirmed idle state before the final
  // Git checks. On timeout retain the checkout; never delete beneath a writer.
  await runtime.quiesce(handle);
  // Recheck immediately before deletion; Git also refuses dirty removal. Herdr
  // removes the checkout and ends its terminals in one operation, never force.
  if (await git(tree.path, ["status", "--porcelain=v1", "--untracked-files=all"]))
    throw new Refusal(`cannot stop ${ticket}: the worktree changed during verification`, `git -C ${tree.path} status`);
  const current = await fleet.runtimeHandle(ticket);
  if (!current || current.handle !== h.handle || current.claimedAt !== h.claimedAt)
    throw new Refusal(`${ticket}'s claim changed; left the runtime untouched`, "armada status");
  const state = await runtime.state(handle);
  if (state !== "idle" && state !== "done")
    throw new Refusal("worker resumed during stop; left its worktree untouched", "armada status");
  if ((await git(tree.path, ["rev-parse", "HEAD"])) !== localHead)
    throw new Refusal(`cannot stop ${ticket}: new commits appeared during verification`, `git -C ${tree.path} status`);
  await runtime.remove(handle, tree.path);
  if (!(await fleet.stopRuntime({ ticket, handle: h.handle, claimedAt: h.claimedAt })))
    throw new Refusal("worktree removed, but claim changed during cleanup; inspect the new claim", "armada status");
  const result = { ticket, path: tree.path, stopped: true };
  io.stdout(
    args.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Stopped ${ticket} and removed ${tree.path}; its branch is retained.\n`,
  );
  return 0;
}
