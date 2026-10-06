// Cleanup runs only after GitHub confirmed the pinned merge and Armada ended its worker generation.
import { dirname, resolve } from "node:path";
import { type ArmadaConfig, type Credentials, type MergeOutcome, runtimeNameOf, shellWord } from "@armada/core";
import { version } from "../package.json" with { type: "json" };
import { type DeferredLaunchResult, launchDeferredAfterMerge } from "./deferred-launch.ts";
import { type Io, UsageError } from "./io.ts";
import { launchWorker } from "./launch.ts";
import { archiveClaimKey, claimRef, guarded, redactRuntimeText, runtimeFor } from "./runtimes/adapter.ts";
import { coordinatorHandle } from "./watch.ts";
import { liveFleet } from "./worker.ts";

export interface ArchiveResult {
  runtime: string | null;
  handle: string | null;
  archived: boolean;
  detail: string;
}

/** Shared by merge callers; notifications must finish before this potentially slow step. */
export async function afterMerge(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  outcome: MergeOutcome,
  opts: {
    noArchive?: boolean;
    keepOpen?: boolean;
    configPath?: string;
    /** Notifications and watch re-arm finish before potentially slow archival. */
    onDeferredLaunch?: (results: DeferredLaunchResult[]) => Promise<void>;
  },
): Promise<ArchiveResult | null> {
  const keepOpen = !!outcome.keepOpen || !!opts.keepOpen;
  const deferred =
    outcome.merged && outcome.pr.mergeCommit && outcome.ticket && !keepOpen
      ? await launchDeferredAfterMerge(outcome, config, liveFleet(io, config, credentials).fleet, async (request) => {
          const printed: string[] = [];
          const code = await launchWorker(
            { ...io, stdout: (line) => printed.push(line) },
            config,
            credentials,
            {
              rest: [request.ticket],
              json: false,
              options: request.profile
                ? { profile: request.profile, reason: "deferred launch requested by the coordinator" }
                : {},
            },
            version,
            opts.configPath ?? resolve(io.cwd, "armada.toml"),
          );
          if (code !== 0) throw new UsageError("the launcher did not start a worker");
          return printed.join("");
        })
      : [];
  await opts.onDeferredLaunch?.(deferred);
  const a = outcome.archive;
  if (!outcome.merged || outcome.pr.mergeCommit === null || !outcome.ticket || !a) return null;
  const result = (archived: boolean, detail: string): ArchiveResult => ({
    runtime: a.runtime,
    handle: a.handle,
    archived,
    detail,
  });
  if (keepOpen || opts.noArchive) return result(false, keepOpen ? "ticket kept open" : "--no-archive");
  const runtime = runtimeNameOf(a.runtime);
  if (!runtime || runtime === "claude-code") {
    const who = `${outcome.ticket.id} (${[a.runtime, a.handle].filter(Boolean).join(" · ") || "session unknown"})`;
    return result(
      false,
      `No runtime guide is installed for ${a.runtime ?? "the worker's runtime"}, so Armada has nothing to archive for ${who}: a local session or subagent ends with its task; stop it yourself if it still runs.`,
    );
  }
  const configPath = opts.configPath ? resolve(io.cwd, opts.configPath) : null;
  const recovery = `armada stop ${shellWord(outcome.ticket.id)} --merged-pr ${shellWord(outcome.pr.url)}${
    a.source === "armada" && a.claim?.releasedAt ? ` --claim-key ${archiveClaimKey(claimRef(a.claim))}` : ""
  }${configPath ? ` --config ${shellWord(configPath)}` : ""}`;
  const failure = (detail: string) => {
    const safe = redactRuntimeText(detail).replace(/\s+/g, " ").trim();
    io.stderr(
      `armada: warning: #${outcome.pr.number} is merged, but the workspace of ${outcome.ticket?.id} was not archived (${safe}); run ${recovery}\n`,
    );
    return result(false, safe);
  };
  if (a.source !== "armada" || !a.claim) return failure("Armada did not return the merged worker's claim");
  const h = a.claim;
  if (h.ticket !== outcome.ticket.id || h.handle !== a.handle || !h.releasedAt)
    return failure("the ended claim does not match the merged ticket");
  const own = coordinatorHandle(io);
  // Conductor archives the workspace, so a different session in our workspace is also protected.
  const sameWorkspace = (left: string, right: string) =>
    runtime === "conductor" && left.split("/")[0] === right.split("/")[0];
  if (own && (h.handle === own || sameWorkspace(h.handle, own)))
    return result(false, "the worker uses the coordinator's workspace");
  if (
    a.open.some(
      (open) =>
        open.handle === h.handle || (runtimeNameOf(open.runtime) === runtime && sameWorkspace(open.handle, h.handle)),
    )
  )
    return result(false, "another open ticket uses the worker's workspace");
  try {
    const { fleet } = liveFleet(io, config, credentials);
    if (!fleet) return failure("Armada is unavailable");
    const ref = claimRef(h);
    const adapter = runtimeFor(configPath ? { ...io, cwd: dirname(configPath) } : io, config, h.runtime);
    const archived = await guarded(fleet, ref, "ended", () =>
      adapter.archive(ref, { reason: "merged", whenWorking: "wait", waitMs: 600_000 }),
    );
    if (!archived.archived && !archived.alreadyGone) return failure("the runtime did not confirm archive");
    try {
      if (!(await fleet.observeRuntime({ ticket: h.ticket, handle: h.handle, claimedAt: h.claimedAt, state: "gone" })))
        throw new Error("the claim changed during cleanup");
    } catch {
      io.stderr(
        `armada: warning: #${outcome.pr.number} is merged and the workspace is archived, but Armada could not record it; run ${recovery}\n`,
      );
      return result(true, "archived; Armada could not record cleanup");
    }
    return result(true, archived.alreadyGone ? "already archived" : "archived");
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}
