// Cleanup runs only after GitHub confirmed the pinned merge and Armada ended its worker generation.
import { dirname, resolve } from "node:path";
import {
  type ArmadaConfig,
  type Credentials,
  deliveryKey,
  type MergeOutcome,
  runtimeNameOf,
  shellWord,
  type WorkerNotice,
} from "@armada/core";
import { version } from "../package.json" with { type: "json" };
import { coordinatorName } from "./coordinator.ts";
import { type DeferredLaunchResult, launchDeferredAfterMerge } from "./deferred-launch.ts";
import { deliverKept } from "./deliveries.ts";
import { type Io, UsageError } from "./io.ts";
import { launchWorker } from "./launch.ts";
import { outgoingRedactor } from "./redact.ts";
import { deliverToRuntime } from "./runtime.ts";
import { archiveClaimKey, claimRef, guarded, redactRuntimeText, runtimeFor } from "./runtimes/adapter.ts";
import { coordinatorHandle } from "./watch.ts";
import { liveFleet } from "./worker.ts";

export interface ArchiveResult {
  runtime: string | null;
  handle: string | null;
  archived: boolean;
  detail: string;
}

export interface WorkerNotification {
  ticket: string;
  delivered: boolean;
  detail: string;
  /** Kept for manual delivery when the runtime is unavailable or unsupported. */
  text: string;
}

export interface AfterMergeResult {
  notified: WorkerNotification[];
  notAffected: { ticket: string; why: string }[];
  archive: ArchiveResult | null;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const shownFiles = (files: string[]) =>
  `${files.slice(0, 4).map(oneLine).join(", ")}${files.length > 4 ? ` (and ${files.length - 4} more)` : ""}`;

/** Fixed text; the key and recipient never depend on a model. Shared sessions receive one message. */
function noticeText(o: MergeOutcome, workers: WorkerNotice[]): string {
  const lines = [
    `${o.pr.base} moved: PR #${o.pr.number} "${oneLine(o.pr.title).slice(0, 200)}"${o.ticket ? ` (${o.ticket.id})` : ""} merged as ${o.pr.mergeCommit?.slice(0, 7)}.`,
  ];
  for (const w of workers) {
    lines.push(
      w.sharedFiles.length
        ? `It changes files your PR #${w.pr.number} (${w.ticket}) also changes: ${shownFiles(w.sharedFiles)}.`
        : `Your PR #${w.pr.number} (${w.ticket}) may be affected: ${oneLine(w.why).slice(0, 500)}.`,
    );
  }
  if (o.hints.length)
    lines.push(
      `Merge hints: ${o.hints
        .slice(0, 3)
        .map((h) => oneLine(h).slice(0, 500))
        .join("; ")}.`,
    );
  lines.push(
    `Before your next push: git fetch origin && git merge ${shellWord(`origin/${o.pr.base}`)}, then run the checks again.`,
  );
  return lines.join("\n");
}

async function notifyWorkers(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  outcome: MergeOutcome,
): Promise<WorkerNotification[]> {
  if (!outcome.merged || !outcome.pr.mergeCommit || !outcome.filesKnown || outcome.noticeFallback) return [];
  const { fleet } = liveFleet(io, config, credentials);
  const owner = await coordinatorName(io, config.project.slug);
  const groups = new Map<string, WorkerNotice[]>();
  for (const w of [...(outcome.notices ?? [])].sort((a, b) => a.ticket.localeCompare(b.ticket))) {
    const key = w.handle ? `${runtimeNameOf(w.runtime) ?? w.runtime}:${w.handle}` : w.ticket;
    groups.set(key, [...(groups.get(key) ?? []), w]);
  }
  if (!groups.size) return [];
  const mask = await outgoingRedactor(io, config, credentials);
  const notified: WorkerNotification[] = [];
  for (const workers of groups.values()) {
    const w = workers[0];
    if (!w) continue;
    let text = mask.text(noticeText(outcome, workers));
    let kept = false;
    let delivered = false;
    let detail = "deliver manually with the runtime guide";
    const runtime = runtimeNameOf(w.runtime);
    if (runtime && runtime !== "claude-code") {
      try {
        if (!fleet) throw new Error("Armada is unavailable");
        if (outcome.workers.some((other) => other.phase === "ready-to-merge" && other.handle === w.handle))
          throw new Error("another handed-back ticket uses this session");
        for (const worker of workers) {
          if (
            !worker.claim ||
            worker.claim.ticket !== worker.ticket ||
            worker.claim.handle !== worker.handle ||
            worker.claim.releasedAt
          )
            throw new Error(`Armada did not return ${worker.ticket}'s active claim`);
          await guarded(fleet, claimRef(worker.claim), "active", async () => {});
        }
        const [events, active] = await Promise.all([fleet.latestEvents(), fleet.runtimeHandles()]);
        const peer = active.find((h) => h.handle === w.handle && h.coordinator != null && h.coordinator !== owner);
        if (peer) {
          outcome.notAffected ??= [];
          outcome.notAffected.push(
            ...workers.map((worker) => ({ ticket: worker.ticket, why: `owned by coordinator ${peer.coordinator}` })),
          );
          continue;
        }
        if (active.some((h) => h.handle === w.handle && events[h.ticket]?.phase === "ready-to-merge"))
          throw new Error("the worker has handed back");
        const key = deliveryKey({
          project: config.project.slug,
          ticket: `${runtime}:${w.handle}`,
          claimedAt: null,
          launchId: null,
          item: null,
          kind: "note",
          text: outcome.pr.mergeCommit,
        });
        const receipt = await fleet.prepareMergeNotice(key);
        const keyed = runtimeFor(io, config, runtime).can.keyedDelivery;
        if (receipt === "attempted") {
          if (!keyed || !w.claim)
            throw new Error(
              "an earlier delivery attempt has an unknown outcome; inspect the session before manual delivery",
            );
          const row = await fleet.keepDelivery({
            key,
            ticket: w.ticket,
            item: null,
            kind: "merge-note",
            text,
            runtime,
            handle: w.claim.handle,
            claimedAt: w.claim.claimedAt,
            launchId: w.claim.workerSessionId ?? null,
            branch: w.claim.branch,
          });
          text = row.text;
          if (row.state !== "delivered") {
            if (row.state === "abandoned")
              detail = `delivery #${row.id} ended: ${row.reason}; inspect the session first`;
            else
              detail = `not confirmed yet; Armada keeps it (delivery #${row.id}) and retries it while armada watch runs`;
            notified.push(...workers.map((worker) => ({ ticket: worker.ticket, delivered: false, detail, text })));
            continue;
          }
          // Native confirmation is terminal; retry only the idempotent generated-note record.
          delivered = true;
          detail = "already delivered";
        }
        if (!delivered) {
          kept = keyed && receipt !== "delivered";
          delivered =
            receipt === "delivered" ||
            (keyed && w.claim
              ? !!(await deliverKept(
                  io,
                  fleet,
                  config,
                  { ...claimRef(w.claim), coordinator: owner, skipHandedBack: true },
                  { key, text, item: null, kind: "merge-note" },
                ))
              : !!(await deliverToRuntime(io, fleet, w.ticket, text, w.claim, config, {
                  kind: "note",
                  key,
                  coordinator: owner,
                  skipHandedBack: true,
                })));
          detail = receipt === "delivered" ? "already delivered" : "delivered";
        }
        if (!delivered) throw new Error("the runtime does not support delivery");
        try {
          for (const worker of workers) {
            if (!worker.claim) continue;
            await guarded(
              fleet,
              { ...claimRef(worker.claim), coordinator: owner, skipHandedBack: true },
              "active",
              () =>
                fleet.answer({
                  note: true,
                  generated: true,
                  deliveryKey: key,
                  ticket: worker.ticket,
                  text,
                  item: null,
                }),
            );
          }
        } catch {
          detail = "delivered; Armada could not record the note";
          io.stderr(
            `armada: warning: #${outcome.pr.number} is merged and its note was delivered to ${workers.map((w) => w.ticket).join(", ")}, but Armada could not record it\n`,
          );
        }
      } catch (error) {
        // A same-generation handover may happen during native provenance checks.
        // Do not suggest manual delivery to a session now owned by a peer.
        const reading =
          !delivered && fleet
            ? await Promise.all([fleet.runtimeHandles().catch(() => []), fleet.latestEvents().catch(() => null)])
            : null;
        const active = reading?.[0] ?? [];
        const sameSession = active.filter((h) => h.handle === w.handle && runtimeNameOf(h.runtime) === runtime);
        const peer = sameSession.find((h) => h.coordinator != null && h.coordinator !== owner);
        if (peer) {
          outcome.notAffected ??= [];
          outcome.notAffected.push(
            ...workers.map((worker) => ({ ticket: worker.ticket, why: `owned by coordinator ${peer.coordinator}` })),
          );
          continue;
        }
        if (sameSession.some((h) => reading?.[1]?.[h.ticket]?.phase === "ready-to-merge")) {
          outcome.notAffected ??= [];
          outcome.notAffected.push(...workers.map((worker) => ({ ticket: worker.ticket, why: "already handed back" })));
          continue;
        }
        detail = `${oneLine(mask.text(error instanceof Error ? error.message : String(error)))}${kept ? "; keep armada watch running; never send it by hand too" : "; deliver manually with the runtime guide"}`;
        io.stderr(
          `armada: warning: #${outcome.pr.number} is merged, but its note for ${workers.map((w) => w.ticket).join(", ")} was not delivered (${detail})\n`,
        );
      }
    }
    notified.push(...workers.map((worker) => ({ ticket: worker.ticket, delivered, detail, text })));
  }
  return notified;
}

/** Shared by merge callers; notifications must finish before this potentially slow step. */
export async function afterMerge(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  outcome: MergeOutcome,
  opts: {
    noArchive?: boolean;
    noNotify?: boolean;
    keepOpen?: boolean;
    configPath?: string;
    onNotified?: (results: WorkerNotification[]) => void;
    onDeferredLaunch?: (results: DeferredLaunchResult[]) => Promise<void>;
  },
): Promise<AfterMergeResult> {
  const keepOpen = !!outcome.keepOpen || !!opts.keepOpen;
  const notified = opts.noNotify ? [] : await notifyWorkers(io, config, credentials, outcome);
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
  opts.onNotified?.(notified);
  const archive = await archiveWorker(io, config, credentials, outcome, opts);
  return { notified, notAffected: outcome.notAffected ?? [], archive };
}

async function archiveWorker(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  outcome: MergeOutcome,
  opts: { noArchive?: boolean; keepOpen?: boolean; configPath?: string },
): Promise<ArchiveResult | null> {
  const a = outcome.archive;
  if (!outcome.merged || outcome.pr.mergeCommit === null || !outcome.ticket || !a) return null;
  const result = (archived: boolean, detail: string): ArchiveResult => ({
    runtime: a.runtime,
    handle: a.handle,
    archived,
    detail,
  });
  const keepOpen = !!outcome.keepOpen || !!opts.keepOpen;
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
