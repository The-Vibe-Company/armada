import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  type ArmadaConfig,
  type BriefResume,
  buildBrief,
  type ClaimRef,
  type Credentials,
  type Fleet,
  fetchBranchPull,
  MERGE_LEASE,
  Refusal,
  RuntimeError,
  releaseTicket,
  reservationsForBrief,
  runtimeNameOf,
  shellWord,
} from "@armada/core";
import { apiOf } from "./api.ts";
import { herdrWorktreePath, herdrWorktreesDirectory } from "./herdr.ts";
import { httpOptions, type Io, UsageError } from "./io.ts";
import { executeLaunch, prepareLaunch, withLaunchLease } from "./launch.ts";
import { requireSignIn } from "./login.ts";
import {
  claimRef,
  guarded,
  recheckMutation,
  redactRuntimeText,
  runtimeFor,
  withRuntimeLease,
} from "./runtimes/adapter.ts";
import { HerdrAdapter } from "./runtimes/herdr.ts";
import { liveFleet, workerContext } from "./worker.ts";

type Args = { rest: string[]; json: boolean; options: Record<string, string> };
export async function relaunch(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: Args,
  version: string,
  configPath: string,
) {
  const [input, ...extra] = args.rest;
  const o = args.options;
  if (!input || extra.length || !/^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/.test(input))
    throw new UsageError('relaunch needs a ticket: armada relaunch <ticket> --reason "<why>"');
  const ticket = input.toUpperCase(),
    reason = o.reason?.trim();
  if (!reason) throw new UsageError('relaunch needs --reason "<why>"');
  if (o["in-place"] && o.fresh) throw new UsageError("choose --in-place or --fresh, not both");
  if (o["reason-profile"] && !o.profile) throw new UsageError("--reason-profile goes with --profile");
  const signIn = requireSignIn(credentials);
  if (signIn.kind === "worker") throw new UsageError("relaunch is a coordinator command");
  const { fleet } = liveFleet(io, config, credentials);
  if (!fleet) throw new UsageError("relaunch needs Armada's live fleet");
  const dry = o["dry-run"] === "true";
  const replace = async () => {
    const [held, launches] = await Promise.all([fleet.runtimeHandle(ticket), fleet.pendingLaunches()]);
    const pending = launches.find((l) => l.ticket === ticket);
    const runtime = runtimeNameOf(pending?.runtime);
    let old: ClaimRef;
    if (held && !held.releasedAt) old = claimRef(held);
    else if (pending) {
      if (!runtime || !pending.handle || !pending.id)
        throw new UsageError(
          `${ticket}'s pending launch has no bound runtime handle; inspect it before relaunching`,
          `armada launch revoke ${ticket}`,
        );
      old = {
        ticket,
        runtime,
        handle: pending.handle,
        claimedAt: null,
        launchId: pending.id,
        releasedAt: null,
        branch: held?.branch,
      };
    } else if (held) old = claimRef(held);
    else throw new UsageError(`${ticket} has no worker to replace`, `armada launch ${ticket}`);
    // Probe the exact-generation read before stopping anything. Older servers
    // must be upgraded before this command can release and clean up safely.
    const reference = await fleet.runtimeReference(old);
    if (!reference || reference.releasedAt !== old.releasedAt)
      throw new UsageError(`${ticket}'s worker generation changed; nothing was released`, `armada peek ${ticket}`);
    if (reference.coordinator === undefined)
      throw new UsageError(
        "Armada must support generation ownership before relaunch; nothing was released",
        "upgrade the Armada API",
      );
    const branch = old.branch ?? "";
    const options = { ...o };
    delete options.reason;
    if (o.profile) options.reason = o["reason-profile"] ?? "";
    const prepared = await prepareLaunch(io, config, credentials, argsWith(args, options), version, configPath, {
      branch,
      coordinator: reference.coordinator,
      preApprovalReason: o["pre-approve"] === "true" ? reason : undefined,
      command: [
        `armada relaunch ${ticket}`,
        ...Object.entries(o).flatMap(([key, value]) =>
          ["pre-approve", "in-place", "fresh", "keep-old", "dry-run"].includes(key)
            ? [`--${key}`]
            : [`--${key} ${shellWord(value)}`],
        ),
        ...(args.json ? ["--json"] : []),
      ].join(" "),
    });
    if (typeof prepared === "number") return prepared;
    // The claim's branch wins over a changed tracker suggestion.
    if (!branch) old.branch = prepared.spec.branch;
    const oldRuntime = runtimeFor({ ...io, cwd: prepared.repo }, config, old.runtime);
    let reading: { state: string } = { state: "unknown" };
    let workspace: { ready: boolean; clean: boolean; path: string | null } | null = null;
    let remoteHerdr = false;
    try {
      workspace = (await oldRuntime.resumeState?.(old)) ?? null;
    } catch (error) {
      if (error instanceof RuntimeError && ["gone", "not-found"].includes(error.code)) reading = { state: "gone" };
      else if (
        old.runtime === "herdr" &&
        error instanceof RuntimeError &&
        error.code === "unavailable" &&
        o.fresh === "true" &&
        o["keep-old"] === "true"
      )
        remoteHerdr = true;
      else throw error;
    }
    if (!remoteHerdr) {
      try {
        reading = await oldRuntime.observe(old);
      } catch (error) {
        if (error instanceof RuntimeError && ["gone", "not-found"].includes(error.code)) reading = { state: "gone" };
        // A readable local checkout is not the remote-machine exception. If
        // its pane cannot be inspected, refuse before releasing its branch.
        else throw error;
      }
    }
    const changedRuntime = prepared.runtimeName !== old.runtime;
    const healthy = workspace?.ready && !["failed", "gone"].includes(reading.state);
    const mode: BriefResume["mode"] =
      o["in-place"] === "true"
        ? "in-place"
        : o.fresh === "true" || changedRuntime || !healthy || (old.runtime === "herdr" && !workspace?.clean)
          ? "fresh"
          : "in-place";
    if (mode === "in-place" && (changedRuntime || !oldRuntime.can.resumeInPlace || !workspace?.ready))
      throw new UsageError(
        `${ticket}'s old workspace cannot resume in place; nothing was released`,
        `armada relaunch ${ticket} --fresh --reason "<why>"`,
      );
    if (!io.exec) throw new UsageError("relaunch needs process execution");
    if (mode === "fresh" && prepared.local && !workspace?.path) {
      const trees = await io.exec("git", ["worktree", "list", "--porcelain"], { cwd: prepared.repo, timeoutMs: 5000 });
      if (trees.code !== 0 || trees.stdout.split("\n").includes(`branch refs/heads/${prepared.spec.branch}`))
        throw new UsageError(
          "the ticket branch may still be checked out locally; nothing was released",
          "git worktree list",
        );
    }
    const remote = await io.exec("git", ["ls-remote", "origin", `refs/heads/${prepared.spec.branch}`], {
      cwd: io.cwd,
      timeoutMs: 20000,
    });
    if (remote.code !== 0) throw new UsageError("could not read the ticket's remote branch; nothing was released");
    const line = remote.stdout.trim();
    const head = line ? (line.split(/\s+/)[0] ?? null) : null;
    if (head && (!/^[a-f0-9]{40,64}$/.test(head) || line.split(/\s+/)[1] !== `refs/heads/${prepared.spec.branch}`))
      throw new UsageError("invalid remote branch reading; nothing was released");
    const pr = await readPull(io, config, credentials, fleet, ticket, prepared.spec.branch);
    prepared.briefInput.resume = {
      branch: prepared.spec.branch,
      head,
      pr,
      reason,
      previous: old.handle,
      mode,
      releasedReservations: prepared.briefInput.reservations
        ?.filter((reservation) => reservation.ticket === ticket && !reservation.merged)
        .map(({ key, value }) => ({ key, value })),
    };
    // Rebuild before the first write to validate all continuation context.
    prepared.preview = buildBrief({
      ...prepared.briefInput,
      ...(prepared.local ? { herdr: { choice: prepared.local, handle: "preview" } } : {}),
    });
    prepared.spec.from =
      mode === "in-place" ? { kind: "in-place", previous: old } : head ? { kind: "branch", head } : { kind: "base" };
    if (mode === "fresh" && prepared.local) {
      const suffix = randomUUID().slice(0, 8);
      const configHome = io.env.XDG_CONFIG_HOME ?? (io.env.HOME ? join(io.env.HOME, ".config") : null);
      const path = io.env.HERDR_CONFIG_PATH ?? (configHome ? join(configHome, "herdr", "config.toml") : null);
      const text = path ? await io.readFile(path).catch(() => null) : null;
      const directory =
        workspace?.path && old.runtime === "herdr"
          ? dirname(workspace.path)
          : dirname(
              herdrWorktreePath(herdrWorktreesDirectory(io.env, text), basename(prepared.repo), prepared.spec.branch),
            );
      prepared.spec.herdrTarget = {
        path: join(directory, `armada-relaunch-${ticket.toLowerCase()}-${suffix}`),
        agent: `relaunch-${ticket.toLowerCase()}-${suffix}`.slice(0, 31),
      };
      if (!prepared.spec.herdrTarget.path.startsWith("/"))
        throw new UsageError("could not resolve a local replacement worktree path; nothing was released");
    }
    if (dry) {
      const result = {
        ticket,
        dryRun: true,
        preApproval: prepared.approval?.preview ?? null,
        old: old.handle,
        mode,
        branch: prepared.spec.branch,
        head,
        pr,
        runtime: prepared.runtimeName,
        profile: prepared.choice.name,
        preflight: { ready: prepared.gaps.length === 0, gaps: prepared.gaps },
      };
      io.stdout(
        args.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `Relaunch plan for ${ticket}: ${mode}, ${prepared.spec.branch} at ${head ?? "base"}; old worker ${old.handle}.\n`,
      );
      if (!args.json && prepared.approval) io.stdout(`${prepared.approval.preview}\n`);
      return prepared.gaps.length ? 1 : 0;
    }
    await recheckMutation();
    const rule = old.releasedAt ? "ended" : "active";
    if (remoteHerdr) io.stderr(`armada: the old herdr pane must be stopped on its machine; keeping ${old.handle}.\n`);
    else
      try {
        await guarded(fleet, old, rule, () => oldRuntime.cancel(old, { waitMs: 30000 }));
      } catch (error) {
        if (!(error instanceof RuntimeError && ["gone", "not-found"].includes(error.code)))
          throw new UsageError(
            `${ticket}: the old worker did not stop; ownership is unchanged`,
            `armada peek ${ticket}`,
          );
      }
    const api = apiOf(io, credentials.armadaApi.url);
    try {
      if (old.claimedAt === null) {
        await recheckMutation();
        await api.revokePendingLaunch(signIn, { project: config.project.slug, ticket, id: old.launchId as string });
      } else {
        const context = workerContext(io, config, credentials);
        context.workerHandle = old.handle;
        const outcome = await guarded(fleet, old, rule, () =>
          releaseTicket(context, { ticket, reason: `relaunch: ${reason}`, claim: old }),
        );
        if (outcome.warnings.length) throw new UsageError("release could not be recorded consistently");
        await recheckMutation();
        await api.endWorkers(signIn, {
          project: config.project.slug,
          ticket,
          reason: "released",
          claimedAt: old.claimedAt,
        });
      }
      const ended = await fleet.runtimeReference(old);
      if (!ended?.releasedAt || ended.coordinator === undefined)
        throw new UsageError("old generation and its ownership were not confirmed ended");
      // Ownership may be handed over during preflight/cancellation. Ended
      // generation metadata is frozen and comes from its authenticated launch.
      prepared.coordinator = ended.coordinator;
      old = { ...ended, branch: old.branch };
    } catch (error) {
      throw new UsageError(
        `${ticket}: the old worker is stopped; release is incomplete. ${safeError(error)}`,
        `armada relaunch ${ticket} --reason "<why>"`,
      );
    }
    Object.assign(
      prepared.briefInput,
      await reservationsForBrief(() => fleet.reservations(), config.reservations.length > 0),
    );
    // A fresh local worktree must not compete for the checked-out branch. Keep
    // the old commits and dirty files under a separate local branch, never reset.
    if (
      mode === "fresh" &&
      old.runtime === "herdr" &&
      !remoteHerdr &&
      workspace?.ready &&
      oldRuntime instanceof HerdrAdapter
    ) {
      const retained = `armada-retained/${ticket.toLowerCase()}-${randomUUID().slice(0, 8)}`;
      try {
        old = await guarded(fleet, old, "ended", () => oldRuntime.retainBranch(old, retained), {
          allowHistorical: true,
        });
      } catch (error) {
        throw await launchFailure(fleet, ticket, error);
      }
      io.stderr(`armada: previous worktree retained on ${retained}.\n`);
    }
    if (mode === "in-place") prepared.spec.from = { kind: "in-place", previous: old };
    let worker: Awaited<ReturnType<typeof executeLaunch>>;
    try {
      worker =
        mode === "in-place"
          ? await guarded(fleet, old, "ended", () => executeLaunch(prepared), { allowHistorical: true })
          : await executeLaunch(prepared);
    } catch (error) {
      throw await launchFailure(fleet, ticket, error);
    }
    let archived = false;
    if (o["keep-old"] !== "true") {
      try {
        if (
          worker.handle === old.handle ||
          (old.runtime === "conductor" && mode === "fresh" && worker.handle.split("/")[0] === old.handle.split("/")[0])
        )
          throw new RuntimeError("replacement shares the old runtime target; retained it", "busy", "armada status");
        const result = await guarded(
          fleet,
          old,
          "ended",
          () =>
            oldRuntime.archive(old, {
              reason: "relaunched",
              whenWorking: "cancel",
              waitMs: 60000,
              workspace: mode === "fresh",
            }),
          { allowHistorical: true },
        );
        archived = result.archived || result.alreadyGone;
      } catch (error) {
        const hint =
          error instanceof RuntimeError && ["busy", "stale", "mismatch"].includes(error.code)
            ? "armada status"
            : old.runtime === "conductor"
              ? `conductor ${mode === "in-place" ? "session" : "workspace"} archive ${old.handle.split("/")[mode === "in-place" ? 1 : 0]}`
              : "use the armada-runtime-herdr guide to close the old pane";
        io.stderr(
          `armada: the replacement is running; old worker ${old.handle} could not be archived. Next: ${hint}\n`,
        );
      }
    }
    const result = {
      ...worker,
      old: { handle: old.handle, stopped: !remoteHerdr, archived, kept: !archived },
      mode,
      head,
      pr,
    };
    io.stdout(
      args.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Relaunched ${ticket}: ${mode} on ${worker.branch} at ${head ?? "base"}.\nOld: ${old.handle} (${archived ? "archived" : "kept"})\nNew: ${worker.handle}\n${worker.link ?? ""}\n${worker.watch.line}\n`,
    );
    return 0;
  };
  if (dry) return replace();
  return withLaunchLease(io, fleet, ticket, async (launchLease) => {
    // The existing merge lock is project-wide; holding it also prevents a merge
    // starting between our preflight and release of its hand-back.
    const holder = `relaunch:${randomUUID()}`;
    // A hold pauses merges, not worker replacement. This reason authorizes
    // only the exclusion lock; relaunch never performs a merge action.
    const lock = { name: MERGE_LEASE, holder, ttlMs: 5 * 60000, throughHold: `relaunch exclusion: ${reason}` };
    if (!(await fleet.acquireLease(lock)).acquired)
      throw new UsageError(
        `${ticket}: a merge is in progress; nothing was changed`,
        `armada relaunch ${ticket} --reason "<why>"`,
      );
    try {
      return await withRuntimeLease(async () => {
        const renewed = await Promise.all([fleet.renewLease(launchLease), fleet.renewLease(lock)]);
        if (renewed.some((ok) => !ok))
          throw new UsageError("relaunch lease was lost; stopped before the next write", `armada peek ${ticket}`);
      }, replace);
    } finally {
      await fleet.releaseLease(lock);
    }
  });
}

function argsWith(args: Args, options: Args["options"]): Args {
  return { ...args, options };
}
function safeError(error: unknown) {
  return redactRuntimeText(
    error instanceof Refusal || error instanceof UsageError ? error.message : "operation failed",
  );
}
async function launchFailure(fleet: Fleet, ticket: string, error: unknown) {
  try {
    const [held, launches] = await Promise.all([fleet.runtimeHandle(ticket), fleet.pendingLaunches()]);
    if (held && !held.releasedAt)
      return new UsageError(
        `${ticket}: a replacement holds the ticket; inspect it. ${safeError(error)}`,
        `armada peek ${ticket}`,
      );
    if (launches.some((l) => l.ticket === ticket))
      return new UsageError(
        `${ticket} is released; a pending launch remains and may be running. ${safeError(error)}`,
        `armada peek ${ticket}`,
      );
    return new UsageError(
      `${ticket} is released, nobody holds it: armada launch ${ticket}. ${safeError(error)}`,
      `armada launch ${ticket}`,
    );
  } catch {
    return new UsageError(
      `${ticket}: launch failed and ownership could not be confirmed. ${safeError(error)}`,
      `armada peek ${ticket}`,
    );
  }
}
async function readPull(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  fleet: Fleet,
  ticket: string,
  branch: string,
): Promise<BriefResume["pr"]> {
  if (credentials.githubToken) {
    const pr = await fetchBranchPull({
      repository: config.github.repository,
      token: credentials.githubToken,
      ...httpOptions(io),
      branch,
    });
    return pr ? { number: pr.number, url: pr.url } : null;
  }
  const url = (await fleet.latestEvents())[ticket]?.prUrl;
  const matched = url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
  return matched && matched[1]?.toLowerCase() === config.github.repository.toLowerCase()
    ? { number: Number(matched[2]), url: url as string }
    : null;
}
