import { sinceSummary } from "../src/catchup.ts";
import {
  assertDeployRetry,
  type DeployInput,
  type DeployQuery,
  type DeployRecord,
  DeployRetryRefusal,
  deployDetail,
  deployFailed,
  deployRetryLine,
} from "../src/deploy.ts";
// The fleet's live data in memory, for tests: the same results as the app's
// Postgres store (`packages/dashboard/lib/fleet-store.ts`, tested on PGlite),
// with its unique rules (one open plan, hand-back and launch request per
// ticket, one open answer per question) and its atomic lease.

import { type Job, jobEndedBody, jobIsOpen, progressMoved } from "../src/jobs.ts";
import type {
  AckedEntry,
  CoordinatorPresence,
  CoordinatorRecord,
  EventInput,
  FleetStore,
  InboxItem,
  Lease,
  MergeHold,
  PendingLaunch,
  ProjectRecord,
  Reservation,
  RuntimeHandle,
  SessionRecord,
  StoredInboxItem,
  WorkerProfile,
} from "../src/live.ts";
import { AckInvalid, FOLLOW_EVENT_KINDS, holdBody, unusedLaunchExpired } from "../src/live.ts";
import { MERGE_QUEUE_LEASE, type QueueEntry, queueOpen, queueRefusedPrefix } from "../src/merge-queue.ts";
import { OBSERVABLE_RUNTIMES, runtimeNameOf } from "../src/runtime.ts";
import type { Validation } from "../src/validations.ts";

interface EventRow extends Omit<EventInput, "at"> {
  id: number;
  at: string;
}

interface HandleRow extends Omit<RuntimeHandle, "profile"> {}

interface ItemRow extends Omit<StoredInboxItem, "request"> {
  requestPr?: number | null;
  requestDeferred?: boolean;
  deferredOptions?: InboxItem["request"];
  requestQuestion: number | null;
  requestProfile: string | null;
  requestValidation?: number | null;
  launchId?: string;
  deployTarget?: string | null;
  deploySha?: string | null;
}

type DeployInputWithCoverage = DeployInput & { project: string; coveredShas?: readonly string[] | null };
type DeployRow = DeployRecord & { coveredShas?: string[] };

/** A launch as the app keeps it (`armada_worker`), with only what the fleet reads of it. */
export interface LaunchRow extends PendingLaunch {
  project: string;
  endedAt: string | null;
  /** Older fixtures do not model the session's idle expiry. */
  sessionExpiresAt?: string | null;
}

const REQUEST_KINDS = ["answer-request", "launch-request", "merge-request", "release-request", "plan-changes"];
const key = (project: string, ticket: string) => `${project}\n${ticket}`;

export function memoryFleet(): FleetStore & {
  events: EventRow[];
  items: ItemRow[];
  deploys: DeployRow[];
  leases: Map<string, Lease>;
  presence: Map<string, { handle: string | null; cliVersion: string | null; at: string }>;
  /** Launches, as the app's `createLaunch` and `exchangeLaunch` write them: tests push and edit them. */
  launches: LaunchRow[];
  validations: Validation[];
} {
  const jobs: Job[] = [];
  const queue: QueueEntry[] = [];
  const projects = new Map<string, ProjectRecord>();
  const events: EventRow[] = [];
  const handles = new Map<string, HandleRow>();
  const paths = new Map<string, string[]>();
  const notices = new Map<string, { delivered: boolean; tickets: Set<string> }>();
  const profiles = new Map<string, WorkerProfile>();
  const items: ItemRow[] = [];
  const deploys: DeployRow[] = [];
  const holds: (MergeHold & { itemId: number; deploySequence?: number; deploySha?: string | null })[] = [];
  const leases = new Map<string, Lease>();
  const presence = new Map<string, { handle: string | null; cliVersion: string | null; at: string }>();
  const coordinators = new Map<string, CoordinatorPresence>();
  const coordinatorSessions = new Map<string, CoordinatorPresence>();
  const sessions: SessionRecord[] = [];
  const launches: LaunchRow[] = [];
  const validations: Validation[] = [];
  const acknowledgements = new Map<string, AckedEntry>();
  const checkAckOwner = (
    project: string,
    ticket: string | null,
    coordinator: string,
    fallback: string | null = null,
  ) => {
    if (!ticket) return;
    const handle = handles.get(key(project, ticket));
    const active = handle && !handle.releasedAt ? handle : null;
    const latest = launches
      .filter((entry) => entry.project === project && entry.ticket === ticket)
      .sort((a, b) => a.launchedAt.localeCompare(b.launchedAt))
      .at(-1);
    const pending =
      latest &&
      !latest.endedAt &&
      !events.some(
        (event) =>
          event.project === project &&
          event.ticket === ticket &&
          event.kind === "claim" &&
          event.at >= latest.launchedAt,
      )
        ? latest
        : null;
    const owner = active ? active.coordinator : pending ? pending.coordinator : fallback;
    if (owner != null && owner !== coordinator) throw new AckInvalid(`target belongs to coordinator ${owner}`);
  };
  const heldResources: Reservation[] = [];
  const copy = (v: Validation): Validation => structuredClone(v);
  const endReservations = (project: string, ticket: string, at: Date, merged: boolean) => {
    for (const r of heldResources)
      if (r.project === project && r.ticket === ticket && !r.endedAt) {
        r.endedAt = at.toISOString();
        r.merged = merged;
      }
  };

  const stored = (r: ItemRow): StoredInboxItem => {
    const {
      requestQuestion,
      requestProfile,
      requestPr,
      requestValidation,
      requestDeferred,
      deferredOptions,
      deployTarget: _target,
      deploySha: _sha,
      ...rest
    } = r;
    return {
      ...rest,
      ...(r.kind === "decision"
        ? { request: { question: null, profile: null, validation: requestValidation ?? null } }
        : {}),
      ...(REQUEST_KINDS.includes(r.kind)
        ? {
            request: {
              question: requestQuestion,
              profile: requestProfile,
              ...(requestDeferred ? { deferred: true, ...deferredOptions } : {}),
              ...(requestPr == null ? {} : { pr: requestPr }),
            },
          }
        : {}),
    };
  };
  const item = (r: ItemRow): InboxItem => {
    const { resolvedAt: _a, resolution: _b, ...rest } = stored(r);
    return rest;
  };
  const handleOf = (h: HandleRow): RuntimeHandle => {
    const lastAnsweredAt = items
      .filter(
        (i) =>
          i.project === h.project &&
          i.ticket === h.ticket &&
          ["question", "plan", "decision"].includes(i.kind) &&
          i.resolvedAt &&
          i.resolvedAt >= h.claimedAt,
      )
      .map((i) => i.resolvedAt)
      .sort()
      .at(-1);
    return {
      ...h,
      profile: profiles.get(key(h.project, h.ticket))?.name ?? null,
      ...(lastAnsweredAt ? { lastAnsweredAt } : {}),
    };
  };
  const insert = (r: Omit<ItemRow, "id" | "resolvedAt" | "resolution">) => {
    const id = items.length + 1;
    items.push({ ...r, id, resolvedAt: null, resolution: null });
    return id;
  };
  const open = (project: string, ticket: string | null, kind: string) =>
    items.find((i) => i.project === project && i.ticket === ticket && i.kind === kind && !i.resolvedAt);
  const resolve = (rows: ItemRow[], resolution: string, at: Date) => {
    for (const r of rows) Object.assign(r, { resolvedAt: at.toISOString(), resolution });
    return rows.length;
  };
  const covered = (input: DeployInputWithCoverage): string[] =>
    input.state === "not-deployed"
      ? []
      : [...new Set([input.sha, ...(input.coveredShas ?? [])].filter((sha): sha is string => !!sha))];
  const deployTerminal = (state: string) => state === "healthy" || deployFailed(state as never);
  const deployBody = (input: DeployInputWithCoverage) =>
    `${input.state === "not-runnable" ? "Deploy check not runnable on this machine (configuration)" : `Deployment ${input.state}`} for ${input.target} (${input.sha})\nLast output:\n${deployDetail(input.detail)}${deployFailed(input.state) ? `\n${deployRetryLine(input.target)}` : ""}`;
  const staleFailure = (record: DeployRow) =>
    deploys.some(
      (row) =>
        row.project === record.project &&
        row.target === record.target &&
        row.state === "healthy" &&
        (row.sha === record.sha || (row.coveredShas ?? []).includes(record.sha)),
    ) ||
    deploys.some(
      (row) =>
        row.project === record.project &&
        row.target === record.target &&
        deployFailed(row.state) &&
        row.sequence > record.sequence,
    );
  const deployNotice = (input: DeployInputWithCoverage, at: Date, preferredId?: number | null) => {
    const body = deployBody(input);
    const current =
      items.find(
        (row) =>
          row.project === input.project &&
          row.kind === "deploy" &&
          row.recipient === "coordinator" &&
          row.deployTarget === input.target &&
          !row.resolvedAt,
      ) ?? (preferredId == null ? undefined : items.find((row) => row.id === preferredId && !row.resolvedAt));
    if (current) {
      const wasKind = current.kind;
      current.body = body;
      current.kind = "deploy";
      current.recipient = "coordinator";
      current.deployTarget = input.target;
      current.deploySha = input.sha;
      if (wasKind !== "deploy" && preferredId !== current.id) {
        const old = items.find((row) => row.id === preferredId && row.id !== current.id && !row.resolvedAt);
        if (old) {
          old.resolvedAt = at.toISOString();
          old.resolution = `superseded by deployment notice for ${input.target}`;
        }
      }
      return current.id;
    }
    return insert({
      project: input.project,
      ticket: null,
      kind: "deploy",
      recipient: "coordinator",
      author: null,
      body,
      createdAt: at.toISOString(),
      requestQuestion: null,
      requestProfile: null,
      deployTarget: input.target,
      deploySha: input.sha,
    });
  };
  const openDeployFailure = (input: DeployInputWithCoverage, record: DeployRow, at: Date) => {
    if (staleFailure(record)) return;
    const current = holds.find(
      (hold) =>
        hold.project === input.project && hold.kind === "deploy" && hold.ref === input.target && !hold.clearedAt,
    );
    if (current?.deploySequence !== undefined && current.deploySequence > record.sequence) return;
    const manuallyCleared = holds
      .filter(
        (hold) =>
          hold.project === input.project &&
          hold.kind === "deploy" &&
          hold.ref === input.target &&
          !!hold.clearedAt &&
          hold.deploySequence !== undefined,
      )
      .sort((a, b) => (b.deploySequence ?? 0) - (a.deploySequence ?? 0))[0];
    if (manuallyCleared?.deploySequence !== undefined && manuallyCleared.deploySequence >= record.sequence) return;
    const previousItemId = current?.itemId;
    const id = deployNotice(input, at, previousItemId);
    if (previousItemId !== undefined && previousItemId !== id) {
      const old = items.find((row) => row.id === previousItemId && !row.resolvedAt);
      if (old) {
        old.resolvedAt = at.toISOString();
        old.resolution = `superseded by deployment notice for ${input.target}`;
      }
    }
    if (current) {
      current.reason = `deployment ${input.state} for ${input.target} (${input.sha})\n${deployDetail(input.detail)}`;
      current.openedAt = at.toISOString();
      current.deploySequence = record.sequence;
      current.deploySha = input.sha;
      current.itemId = id;
      return;
    }
    holds.push({
      id: holds.length + 1,
      project: input.project,
      kind: "deploy",
      ref: input.target,
      reason: `deployment ${input.state} for ${input.target} (${input.sha})\n${deployDetail(input.detail)}`,
      openedBy: null,
      openedAt: at.toISOString(),
      clearedAt: null,
      clearedBy: null,
      clearReason: null,
      itemId: id,
      deploySequence: record.sequence,
      deploySha: input.sha,
    });
  };
  const clearDeployHealthy = (input: DeployInputWithCoverage, record: DeployRow, at: Date) => {
    const shas = covered(input);
    for (const hold of holds) {
      if (hold.project !== input.project || hold.kind !== "deploy" || hold.ref !== input.target || hold.clearedAt)
        continue;
      if (hold.deploySha && !shas.includes(hold.deploySha)) continue;
      if (!hold.deploySha && hold.deploySequence !== undefined && hold.deploySequence > record.sequence) continue;
      hold.clearedAt = at.toISOString();
      hold.clearedBy = null;
      hold.clearReason = `deployment healthy for ${input.target} (${input.sha}${record.attempt > 1 ? `, attempt ${record.attempt}` : ""})`;
      const notice = items.find((item) => item.id === hold.itemId);
      if (notice && !notice.resolvedAt) {
        notice.resolvedAt = at.toISOString();
        notice.resolution = hold.clearReason;
      }
    }
    for (const notice of items) {
      if (
        notice.project === input.project &&
        notice.kind === "deploy" &&
        notice.deployTarget === input.target &&
        !notice.resolvedAt &&
        (!notice.deploySha || shas.includes(notice.deploySha))
      ) {
        notice.resolvedAt = at.toISOString();
        notice.resolution = `deployment healthy for ${input.target} (${input.sha}${record.attempt > 1 ? `, attempt ${record.attempt}` : ""})`;
      }
    }
  };

  return {
    async recordLaunchFailure(i) {
      if (!i.launchId) {
        const request = items.find((r) => r.project === i.project && r.ticket === i.ticket && r.id === i.requestId);
        if (
          !request ||
          request.resolvedAt ||
          !request.requestDeferred ||
          (request.coordinator ?? "default") !== (i.coordinator ?? "default") ||
          request.deferredOptions?.attempts !== i.attempt ||
          request.deferredOptions?.attemptedAt !== i.attemptedAt ||
          launches.some(
            (l) => l.project === i.project && l.ticket === i.ticket && l.launchedAt >= (i.attemptedAt ?? ""),
          ) ||
          (handles.get(key(i.project, i.ticket))?.claimedAt ?? "") >= (i.attemptedAt ?? "")
        )
          return;
      }
      const launch = launches.find((l) => l.project === i.project && l.ticket === i.ticket && l.id === i.launchId);
      const handle = handles.get(key(i.project, i.ticket));
      if (launch && handle && handle.claimedAt >= launch.launchedAt) return;
      if (
        launch &&
        items.some(
          (r) =>
            r.project === i.project &&
            r.ticket === i.ticket &&
            r.requestDeferred &&
            (r.deferredOptions?.attemptedAt ?? "") > launch.launchedAt,
        )
      )
        return;
      if (
        launch &&
        launches.some(
          (l) =>
            l.project === i.project &&
            l.ticket === i.ticket &&
            (l.launchedAt > launch.launchedAt ||
              (l.launchedAt === launch.launchedAt && (l.id ?? "") > (launch.id ?? ""))),
        )
      )
        return;
      const existing = items.find(
        (r) =>
          r.project === i.project &&
          r.ticket === i.ticket &&
          !r.resolvedAt &&
          (r.kind === "launch-failed" || r.kind === "launch-uncertain"),
      );
      const previous = existing && launches.find((l) => l.id === existing.launchId);
      if (
        launch &&
        previous &&
        (previous.launchedAt > launch.launchedAt ||
          (previous.launchedAt === launch.launchedAt && (previous.id ?? "") > (launch.id ?? "")))
      )
        return;
      const row = {
        ...i,
        coordinator: launch ? (launch.coordinator ?? null) : (i.coordinator ?? null),
        kind: i.outcome === "failed" ? ("launch-failed" as const) : ("launch-uncertain" as const),
        recipient: "coordinator" as const,
        author: null,
        body: `${i.reason}\nNext: ${i.next}`,
        createdAt: i.at.toISOString(),
        requestQuestion: null,
        requestProfile: null,
      };
      if (existing) Object.assign(existing, row);
      else insert(row);
    },
    async digestRecords(project, since, now) {
      const start = since ?? new Date(now.getTime() - 4 * 60 * 60_000).toISOString();
      const rows = events.filter((e) => e.project === project && e.at >= start && e.at <= now.toISOString());
      return {
        language: "en",
        input: {
          since: start,
          until: now.toISOString(),
          now,
          inFlight: [],
          phaseMedians: {},
          summary: sinceSummary({
            since: start,
            now,
            records: [
              {
                project,
                silentAfterMinutes: 15,
                merged: rows.filter((e) => e.kind === "merge").map((e) => ({ ticket: e.ticket ?? "", at: e.at })),
                claimed: [],
                blocked: [],
                gaps: [],
                waiting: validations
                  .filter((v) => v.project === project && !v.decision)
                  .map((v) => ({ id: v.id, ticket: v.ticket, kind: v.kind })),
              },
            ],
          }),
        },
      };
    },
    events,
    items,
    deploys,
    leases,
    presence,
    launches,
    validations,
    async prepareMergeNotice(project, deliveryKey) {
      const k = key(project, deliveryKey);
      const previous = notices.get(k);
      if (previous) return previous.delivered ? "delivered" : "attempted";
      notices.set(k, { delivered: false, tickets: new Set() });
      return "reserved";
    },
    async recordMergeNotice(q) {
      const receipt = notices.get(key(q.project, q.key));
      if (!receipt) throw new Error("merge notice was not reserved");
      if (receipt.tickets.has(q.ticket)) return "Generated note already recorded.";
      const id = insert({
        project: q.project,
        ticket: q.ticket,
        kind: "note",
        recipient: "worker",
        author: "coordinator",
        coordinator: q.coordinator,
        body: q.text,
        createdAt: q.at.toISOString(),
        requestQuestion: null,
        requestProfile: null,
      });
      resolve(
        items.filter((i) => i.id === id),
        "delivered through the runtime",
        q.at,
      );
      receipt.delivered = true;
      receipt.tickets.add(q.ticket);
      return `Note #${id} recorded.`;
    },

    async retryDeploy(input) {
      const hold = holds.find(
        (h) => h.project === input.project && h.kind === "deploy" && h.ref === input.target && !h.clearedAt,
      );
      const sha = input.sha ?? hold?.deploySha;
      const row = deploys
        .filter(
          (r) =>
            r.project === input.project &&
            r.target === input.target &&
            (sha
              ? r.sha === sha
              : (deployFailed(r.state) || r.state === "waiting" || r.state === "live") && !staleFailure(r)),
        )
        .sort((a, b) => b.sequence - a.sequence)[0];
      if (!row) throw new DeployRetryRefusal(`no failed deploy for ${input.target}`);
      assertDeployRetry(row);
      Object.assign(row, {
        state: "waiting",
        attempt: row.attempt + 1,
        redeploySince: input.redeploy ? input.at.toISOString() : null,
        sequence: deploys.reduce((max, r) => Math.max(max, r.sequence), 0) + 1,
        startedAt: input.at.toISOString(),
        updatedAt: input.at.toISOString(),
        detail: `retry requested by ${input.author}`,
        liveSha: null,
        coveredShas: [],
      });
      return structuredClone(row);
    },
    async recordDeploy(input: DeployInputWithCoverage & { at: Date }) {
      const detail = deployDetail(input.detail);
      const known = deploys.find(
        (row) => row.project === input.project && row.target === input.target && row.sha === input.sha,
      );
      if (known && (input.attempt ?? 1) < known.attempt) return structuredClone(known);
      if (known && input.state === "skipped" && known.state !== "skipped") return structuredClone(known);
      if (known && deployTerminal(known.state) && (input.attempt ?? 1) === known.attempt) {
        if (known.state === "healthy" && input.state === "healthy") {
          const previousCovered = known.coveredShas ?? [known.sha];
          const mergedCovered = [...new Set([...previousCovered, ...covered(input)])];
          if (mergedCovered.length > previousCovered.length) {
            known.coveredShas = mergedCovered;
            known.updatedAt = new Date(Math.max(Date.parse(known.updatedAt), input.at.getTime())).toISOString();
            clearDeployHealthy({ ...input, coveredShas: mergedCovered }, known, input.at);
          }
        }
        return structuredClone(known);
      }
      const row: DeployRow = known ?? {
        project: input.project,
        target: input.target,
        sha: input.sha,
        state: input.state,
        detail,
        pauseOnFailure: input.pauseOnFailure,
        liveSha: input.liveSha ?? null,
        coveredShas: covered(input),
        startedAt: input.at.toISOString(),
        updatedAt: input.at.toISOString(),
        attempt: input.attempt ?? 1,
        redeploySince: null,
        sequence: deploys.reduce((max, candidate) => Math.max(max, candidate.sequence), 0) + 1,
      };
      if (known) {
        if (
          ["skipped", "not-runnable", "not-deployed"].includes(row.state) &&
          !["skipped", "not-runnable", "not-deployed"].includes(input.state)
        )
          row.startedAt = input.at.toISOString();
        Object.assign(row, {
          attempt: input.attempt ?? 1,
          state: input.state,
          detail,
          pauseOnFailure: input.pauseOnFailure,
          liveSha: input.liveSha ?? null,
          coveredShas: covered(input),
          updatedAt: input.at.toISOString(),
        });
      } else deploys.push(row);
      if (row.state === "healthy") clearDeployHealthy(input, row, input.at);
      else if (row.state === "not-runnable") {
        if (
          !staleFailure(row) &&
          !holds.some(
            (h) => h.project === input.project && h.kind === "deploy" && h.ref === input.target && !h.clearedAt,
          )
        )
          deployNotice(input, input.at);
      } else if (deployFailed(row.state)) {
        if (input.pauseOnFailure) openDeployFailure(input, row, input.at);
        else if (!staleFailure(row)) deployNotice(input, input.at);
      }
      return structuredClone(row);
    },
    async deployState(project: string, query: DeployQuery = {}) {
      let rows = deploys.filter((row) => row.project === project);
      if (query.target !== undefined) rows = rows.filter((row) => row.target === query.target);
      if (query.sha !== undefined) rows = rows.filter((row) => row.sha === query.sha);
      if (query.target === undefined && query.sha === undefined) {
        const latest = new Map<string, DeployRow>();
        for (const row of rows) {
          const previous = latest.get(row.target);
          if (!previous || row.sequence > previous.sequence) latest.set(row.target, row);
        }
        rows = [...latest.values()];
      } else if (query.target !== undefined && query.sha === undefined) {
        rows = rows
          .map((row) => ({
            row,
            held:
              holds.some(
                (hold) =>
                  hold.project === project &&
                  hold.kind === "deploy" &&
                  hold.ref === row.target &&
                  !hold.clearedAt &&
                  hold.deploySha === row.sha,
              ) ||
              items.some(
                (item) =>
                  item.project === project &&
                  item.kind === "deploy" &&
                  item.deployTarget === row.target &&
                  !item.resolvedAt &&
                  item.deploySha === row.sha,
              ),
          }))
          .sort((a, b) => Number(b.held) - Number(a.held) || b.row.sequence - a.row.sequence)
          .slice(0, 100)
          .map(({ row }) => row);
      } else rows = rows.sort((a, b) => b.sequence - a.sequence);
      return structuredClone(rows);
    },

    async startJob(input) {
      const job: Job = {
        id: jobs.length + 1,
        revision: 0,
        project: input.project,
        ticket: input.ticket,
        name: input.name,
        ref: null,
        state: "starting",
        progress: null,
        eta: null,
        startedBy: input.startedBy,
        startedAt: input.at.toISOString(),
        observedAt: input.at.toISOString(),
        progressChangedAt: input.at.toISOString(),
        finishedAt: null,
      };
      jobs.push(job);
      return structuredClone(job);
    },
    async getJob(project, id) {
      return structuredClone(jobs.find((j) => j.project === project && j.id === id) ?? null);
    },
    async listJobs(project, q) {
      return structuredClone(
        jobs
          .filter(
            (j) =>
              j.project === project &&
              (!q.ticket || j.ticket === q.ticket) &&
              (!q.open || jobIsOpen(j)) &&
              (q.id === undefined || q.id === j.id),
          )
          .sort((a, b) => b.id - a.id),
      );
    },
    async observeJob(input) {
      const job = jobs.find((j) => j.project === input.project && j.id === input.id && j.ticket === input.ticket);
      if (!job) return null;
      if (
        jobIsOpen(job) &&
        (input.expectedRevision === undefined || input.expectedRevision === job.revision) &&
        input.at.getTime() >= Date.parse(job.observedAt) &&
        (input.ref === undefined || job.ref === null || input.ref === job.ref)
      ) {
        if (job.ref === null && input.ref !== undefined) job.ref = input.ref;
        job.revision = (job.revision ?? 0) + 1;
        job.state = input.state;
        if (input.progress !== undefined) {
          if (progressMoved(job.progress, input.progress)) job.progressChangedAt = input.at.toISOString();
          job.progress = input.progress;
        }
        job.eta = input.state === "running" ? (input.eta ?? null) : null;
        job.observedAt = input.at.toISOString();
        if (!jobIsOpen(job)) {
          job.finishedAt = input.at.toISOString();
          const worker = launches.find(
            (l) =>
              l.id === job.startedBy &&
              l.project === job.project &&
              l.ticket === job.ticket &&
              l.tokenUsedAt &&
              !l.endedAt &&
              (l.sessionExpiresAt === undefined ||
                (l.sessionExpiresAt !== null && l.sessionExpiresAt > input.at.toISOString())),
          );
          insert({
            project: job.project,
            ticket: job.ticket,
            kind: "job",
            recipient: worker ? "worker" : "coordinator",
            author: null,
            body: jobEndedBody(job),
            createdAt: input.at.toISOString(),
            requestQuestion: null,
            requestProfile: null,
          });
        }
      }
      return structuredClone(job);
    },
    async openHold(input) {
      const ref = input.kind === "manual" ? null : (input.ref ?? null);
      const existing =
        ref === null
          ? null
          : holds.find((h) => h.project === input.project && h.kind === input.kind && h.ref === ref && !h.clearedAt);
      if (existing) {
        const { itemId: _, ...hold } = existing;
        return { ...hold };
      }
      const hold: MergeHold = {
        id: holds.length + 1,
        project: input.project,
        kind: input.kind,
        ref,
        reason: input.reason,
        openedBy: input.author,
        openedAt: input.at.toISOString(),
        clearedAt: null,
        clearedBy: null,
        clearReason: null,
      };
      const itemId = insert({
        project: input.project,
        ticket: null,
        kind: "hold",
        recipient: "coordinator",
        author: input.author,
        body: holdBody(hold),
        createdAt: hold.openedAt,
        requestQuestion: null,
        requestProfile: null,
      });
      holds.push({ ...hold, itemId });
      return { ...hold };
    },
    async clearHold(input) {
      const row = holds.find((h) => h.project === input.project && h.id === input.id);
      if (!row) return null;
      const cleared = !row.clearedAt;
      if (cleared) {
        row.clearedAt = input.at.toISOString();
        row.clearedBy = input.author;
        row.clearReason = input.reason;
        const item = items.find((i) => i.id === row.itemId);
        if (item) {
          item.resolvedAt = row.clearedAt;
          item.resolution = input.reason;
        }
      }
      const { itemId: _, ...hold } = row;
      return { hold: { ...hold }, cleared };
    },
    async openHolds(project) {
      return holds.filter((h) => h.project === project && !h.clearedAt).map(({ itemId: _, ...hold }) => ({ ...hold }));
    },
    async reserve(input) {
      const held = heldResources.filter(
        (r) => r.project === input.project && r.key === input.key && (!r.endedAt || r.merged),
      );
      const value = input.next
        ? (
            held.reduce(
              (max, r) => (/^[+-]?[0-9]+$/.test(r.value) && BigInt(r.value) > max ? BigInt(r.value) : max),
              BigInt(input.floor ?? 0),
            ) + 1n
          ).toString()
        : (input.value ?? "");
      const holder = held.find((r) => r.value === value);
      if (holder) return { reserved: false, holder: structuredClone(holder) };
      const reservation: Reservation = {
        id: heldResources.length + 1,
        project: input.project,
        key: input.key,
        value,
        ticket: input.ticket,
        note: input.note ?? null,
        reservedAt: input.at.toISOString(),
        endedAt: null,
        merged: false,
      };
      heldResources.push(reservation);
      return { reserved: true, reservation: structuredClone(reservation) };
    },
    async reservations(project) {
      return structuredClone(heldResources.filter((r) => r.project === project && (!r.endedAt || r.merged)));
    },
    async unreserve(input) {
      const rows = heldResources.filter(
        (r) =>
          r.project === input.project && r.ticket === input.ticket && r.key === input.key && !r.endedAt && !r.merged,
      );
      for (const r of rows) r.endedAt = input.at.toISOString();
      return rows.length;
    },
    async ensureProject(p, at) {
      if (projects.has(p.slug)) return;
      const t = at.toISOString();
      projects.set(p.slug, { ...p, organization: null, createdAt: t, updatedAt: t });
    },
    async upsertProject(p, at) {
      const was = projects.get(p.slug);
      if (!was) return this.ensureProject(p, at);
      if (
        was.name !== p.name ||
        was.repository !== p.repository ||
        was.programRoot !== p.programRoot ||
        (!was.owner && p.owner)
      )
        projects.set(p.slug, { ...was, ...p, owner: was.owner ?? p.owner ?? null, updatedAt: at.toISOString() });
    },
    async listProjects() {
      return [...projects.values()].sort((a, b) => a.slug.localeCompare(b.slug));
    },

    async saveTicketPaths(project, ticket, declared) {
      paths.set(key(project, ticket), [...declared]);
    },
    async ticketPaths(project) {
      return Object.fromEntries(
        [...paths].filter(([k]) => k.startsWith(`${project}\n`)).map(([k, v]) => [k.slice(project.length + 1), [...v]]),
      );
    },
    async deleteTicketPaths(project, ticket, guard) {
      const h = handles.get(key(project, ticket));
      if (guard?.absent && h) return;
      if (
        guard &&
        !guard.absent &&
        (!h ||
          (guard.handle && h.handle !== guard.handle) ||
          (guard.claimedAt && h.claimedAt !== new Date(guard.claimedAt).toISOString()) ||
          (guard.workerSessionId && h.workerSessionId && h.workerSessionId !== guard.workerSessionId))
      )
        return;
      paths.delete(key(project, ticket));
    },
    async recordEvent(e) {
      events.push({ ...e, id: events.length + 1, at: e.at.toISOString() });
      if (e.kind === "report") {
        const session = sessions.find(
          (session) => session.project === e.project && session.ticket === e.ticket && !session.releasedAt,
        );
        if (session && (!session.lastReport || session.lastReport.at <= e.at.toISOString()))
          session.lastReport = {
            at: e.at.toISOString(),
            message: e.message ?? null,
            phase: e.phase ?? null,
            shippingStage: e.shippingStage ?? null,
          };
      }
    },
    async lastEventTimes(project) {
      const out: Record<string, string> = {};
      for (const e of events)
        if (
          e.kind !== "heartbeat" &&
          e.kind !== "handover" &&
          e.project === project &&
          e.ticket &&
          (!out[e.ticket] || e.at > (out[e.ticket] ?? ""))
        )
          out[e.ticket] = e.at;
      return out;
    },
    async eventsSince(project, q) {
      const boundary = (e: EventRow, at: string, id: number) => e.at > at || (e.at === at && e.id > id);
      const floor = new Date(Date.parse(q.afterAt) - 120_000).toISOString();
      const recent = events
        .filter(
          (e) =>
            e.project === project &&
            q.kinds.includes(e.kind as never) &&
            (!q.handoverOnly || e.kind !== "report" || e.phase === "ready-to-merge") &&
            (!q.tickets || q.tickets.includes(e.ticket)) &&
            !q.excludedTickets?.includes(e.ticket) &&
            e.at >= floor &&
            !boundary(e, q.afterAt, q.afterId),
        )
        .sort((a, b) => b.id - a.id)
        .slice(0, 500)
        .map((e) => e.id);
      return events
        .filter(
          (e) =>
            e.project === project &&
            FOLLOW_EVENT_KINDS.includes(e.kind as never) &&
            q.kinds.includes(e.kind as never) &&
            (!q.handoverOnly || e.kind !== "report" || e.phase === "ready-to-merge") &&
            (!q.tickets || q.tickets.includes(e.ticket)) &&
            !q.excludedTickets?.includes(e.ticket) &&
            e.at >= floor &&
            (boundary(e, q.afterAt, q.afterId) || (q.seenIds && recent.includes(e.id) && !q.seenIds.includes(e.id))) &&
            (!q.pageAfter || boundary(e, q.pageAfter.at, q.pageAfter.id)),
        )
        .sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id)
        .slice(0, q.limit ?? 200)
        .map((e) => ({
          id: e.id,
          ticket: e.ticket,
          kind: e.kind as "claim",
          phase: e.phase ?? null,
          shippingStage: e.shippingStage ?? null,
          message: e.message ?? null,
          runtime: e.runtime ?? null,
          handle: e.handle ?? null,
          prUrl: e.prUrl ?? null,
          headSha: e.headSha ?? null,
          at: e.at,
        }));
    },
    async latestEvents(project, opts = {}) {
      const since = opts.since?.toISOString() ?? "";
      const out: Record<string, EventRow> = {};
      for (const e of events) {
        if (
          e.kind === "heartbeat" ||
          e.kind === "handover" ||
          e.project !== project ||
          !e.ticket ||
          e.at < since ||
          (opts.kinds && !opts.kinds.includes(e.kind)) ||
          (opts.tickets && !opts.tickets.includes(e.ticket))
        )
          continue;
        const was = out[e.ticket];
        if (!was || e.at > was.at || (e.at === was.at && e.id > was.id)) out[e.ticket] = e;
      }
      return Object.fromEntries(
        Object.entries(out).map(([t, e]) => [
          t,
          {
            id: e.id,
            kind: e.kind,
            phase: e.phase ?? null,
            shippingStage: e.shippingStage ?? null,
            message: e.message ?? null,
            runtime: e.runtime ?? null,
            handle: e.handle ?? null,
            prUrl: e.prUrl ?? null,
            at: e.at,
          },
        ]),
      );
    },
    async recordCoordinatorSeen(seen) {
      const was = presence.get(seen.project);
      const at = seen.at.toISOString();
      if (!was || was.at <= at)
        presence.set(seen.project, {
          handle: seen.facts?.handle ?? seen.handle ?? null,
          cliVersion: seen.cliVersion ?? seen.facts?.cliVersion ?? was?.cliVersion ?? null,
          at,
        });
      const name = seen.name ?? seen.facts?.name ?? "default";
      const roleKey = key(seen.project, name);
      const handle = seen.facts ? seen.facts.handle : (seen.handle ?? null);
      const sessionKey = key(roleKey, handle ?? "");
      const previous = coordinatorSessions.get(sessionKey);
      const next: CoordinatorPresence = {
        name,
        harness: seen.facts?.harness ?? previous?.harness ?? null,
        handle,
        model: seen.facts ? seen.facts.model : (previous?.model ?? null),
        cliVersion: seen.cliVersion ?? seen.facts?.cliVersion ?? previous?.cliVersion ?? null,
        startedAt: previous && seen.at.getTime() - Date.parse(previous.seenAt) < 30 * 60_000 ? previous.startedAt : at,
        seenAt: at,
        inboxSeenAt: seen.inboxRead === false ? (previous?.inboxSeenAt ?? null) : at,
      };
      if (!previous || previous.seenAt <= at) coordinatorSessions.set(sessionKey, next);
      const role = coordinators.get(roleKey);
      if (!role || role.seenAt <= at) coordinators.set(roleKey, next);
      if (seen.inboxRead !== false)
        await this.recordEvent({
          project: seen.project,
          ticket: "",
          kind: "inbox",
          handle: seen.facts?.handle ?? seen.handle ?? null,
          at: seen.at,
        });
    },
    async lastCoordinatorSeen(project) {
      return presence.get(project)?.at ?? null;
    },
    async getCoordinatorPresence(project) {
      return (
        [...coordinators.entries()]
          .filter(([k]) => k.startsWith(`${project}\n`))
          .map(([, value]) => value)
          .sort((a, b) => b.seenAt.localeCompare(a.seenAt))[0] ?? null
      );
    },
    async listCoordinators(project) {
      const records = new Map<string, CoordinatorRecord>();
      for (const [k, role] of coordinators) {
        if (!k.startsWith(`${project}\n`)) continue;
        const name = role.name ?? "default";
        records.set(name, {
          ...role,
          name,
          sessions: [...coordinatorSessions.entries()]
            .filter(([k]) => k.startsWith(`${key(project, name)}\n`))
            .map(([, session]) => ({ ...session }))
            .sort((a, b) => b.seenAt.localeCompare(a.seenAt)),
          tickets: [],
        });
      }
      const active = [...handles.values()].filter((h) => h.project === project && !h.releasedAt);
      const pending = await this.pendingLaunches(project, new Date(0));
      for (const owned of [...active, ...pending]) {
        const name = owned.coordinator;
        if (!name) continue;
        let record = records.get(name);
        if (!record) {
          const at = "claimedAt" in owned ? owned.claimedAt : owned.launchedAt;
          record = {
            name,
            harness: null,
            handle: null,
            model: null,
            cliVersion: null,
            startedAt: at,
            seenAt: at,
            inboxSeenAt: null,
            sessions: [],
            tickets: [],
          };
          records.set(name, record);
        }
        if (!record.tickets.includes(owned.ticket)) record.tickets.push(owned.ticket);
      }
      return [...records.values()]
        .map((r) => ({ ...r, tickets: r.tickets.sort() }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async transferTickets(input) {
      const pending = (await this.pendingLaunches(input.project, new Date(0))).filter(
        (launch) => !unusedLaunchExpired(launch, input.at),
      );
      const rows = input.tickets.map((ticket) => {
        const handle = handles.get(key(input.project, ticket));
        return handle && !handle.releasedAt
          ? handle
          : (pending.find((launch) => launch.ticket === ticket) ?? open(input.project, ticket, "launch-request"));
      });
      if (
        rows.some(
          (row) =>
            !row ||
            (input.from !== undefined
              ? row.coordinator !== input.from
              : row.coordinator != null && row.coordinator !== input.to),
        )
      )
        return false;
      for (const row of rows) {
        if (!row) continue;
        const previous = row.coordinator ?? null;
        row.coordinator = input.to;
        for (const request of items)
          if (
            request.project === input.project &&
            request.ticket === row.ticket &&
            request.requestDeferred &&
            !request.resolvedAt
          )
            request.coordinator = input.to;
        for (const launch of launches)
          if (
            launch.project === input.project &&
            launch.ticket === row.ticket &&
            !launch.endedAt &&
            ("claimedAt" in row || ("launchedAt" in row && launch.launchedAt === row.launchedAt))
          )
            launch.coordinator = input.to;
        for (const session of sessions)
          if (session.project === input.project && session.ticket === row.ticket && !session.releasedAt)
            session.coordinator = input.to;
        events.push({
          id: events.length + 1,
          project: input.project,
          ticket: row.ticket!,
          kind: "handover",
          message: `coordinator ${previous ?? "unowned"} -> ${input.to}`,
          at: input.at.toISOString(),
        });
      }
      return true;
    },
    async inboxReads(project, now) {
      return events
        .filter(
          (event) =>
            event.project === project &&
            event.kind === "inbox" &&
            Date.parse(event.at) >= now.getTime() - 7 * 24 * 60 * 60_000 &&
            Date.parse(event.at) <= now.getTime(),
        )
        .map((event) => ({ id: event.id, at: event.at, handle: event.handle ?? null }));
    },
    async listSessions(project, opts) {
      return sessions
        .filter(
          (session) =>
            session.project === project && (!session.releasedAt || session.releasedAt >= opts.since.toISOString()),
        )
        .map((session) => ({ ...session }));
    },

    async saveWorkerProfile(w) {
      const session = sessions.find(
        (session) => session.project === w.project && session.ticket === w.ticket && !session.releasedAt,
      );
      if (session)
        Object.assign(session, {
          profile: w.profile?.name ?? null,
          agent: w.profile?.agent ?? null,
          model: w.profile?.model ?? null,
          effort: w.profile?.effort ?? null,
        });
      if (w.profile) profiles.set(key(w.project, w.ticket), w.profile);
      else profiles.delete(key(w.project, w.ticket));
    },
    async getWorkerProfile(project, ticket) {
      return profiles.get(key(project, ticket)) ?? null;
    },
    async saveRuntimeHandle(h) {
      const was = handles.get(key(h.project, h.ticket));
      const same =
        was &&
        was.handle === h.handle &&
        was.runtime === h.runtime &&
        !was.releasedAt &&
        (was.workerSessionId ?? null) === (h.workerSessionId ?? null);
      if (!same) {
        const previous = sessions.find(
          (session) => session.project === h.project && session.ticket === h.ticket && !session.releasedAt,
        );
        if (previous) previous.releasedAt = h.at.toISOString();
        sessions.push({
          project: h.project,
          ticket: h.ticket,
          runtime: h.runtime,
          handle: h.handle,
          branch: h.branch,
          coordinator: h.coordinator ?? null,
          claimedAt: h.at.toISOString(),
          releasedAt: null,
          profile: null,
          agent: null,
          model: null,
          effort: null,
          lastReport: null,
        });
      }
      handles.set(key(h.project, h.ticket), {
        project: h.project,
        ticket: h.ticket,
        runtime: h.runtime,
        handle: h.handle,
        branch: h.branch,
        coordinator: same ? (was.coordinator ?? null) : (h.coordinator ?? null),
        claimedAt: same ? was.claimedAt : h.at.toISOString(),
        releasedAt: null,
        lastHeartbeatAt: same && was.workerSessionId === h.workerSessionId ? was.lastHeartbeatAt : null,
        workerSessionId: h.workerSessionId,
        runtimeState: same ? was.runtimeState : null,
      });
    },
    async getRuntimeReference(project, ref) {
      const current = handles.get(key(project, ref.ticket));
      if (ref.claimedAt) {
        if (current && current.handle === ref.handle && current.claimedAt === ref.claimedAt) {
          if ((current.workerSessionId ?? null) !== ref.launchId) return null;
          return {
            ...ref,
            releasedAt: current.releasedAt,
            branch: current.branch,
            coordinator: current.coordinator ?? null,
          };
        }
        const row = sessions.find(
          (s) =>
            s.project === project &&
            s.ticket === ref.ticket &&
            s.handle === ref.handle &&
            s.claimedAt === ref.claimedAt &&
            runtimeNameOf(s.runtime) === ref.runtime,
        );
        return row
          ? { ...ref, releasedAt: row.releasedAt, branch: row.branch, coordinator: row.coordinator ?? null }
          : null;
      }
      const row = launches.find(
        (l) =>
          l.project === project &&
          l.ticket === ref.ticket &&
          l.id === ref.launchId &&
          l.handle === ref.handle &&
          l.runtime === ref.runtime,
      );
      return row ? { ...ref, releasedAt: row.endedAt, coordinator: row.coordinator ?? null } : null;
    },
    async observeRuntime(input) {
      const h = handles.get(key(input.project, input.ticket));
      if (
        !h ||
        !OBSERVABLE_RUNTIMES.includes(runtimeNameOf(h.runtime) as "herdr" | "conductor") ||
        (h.releasedAt && input.state !== "gone") ||
        h.handle !== input.handle ||
        h.claimedAt !== input.claimedAt ||
        (h.runtimeState && h.runtimeState.at > input.at.toISOString())
      )
        return false;
      const sequence = input.sequence ?? h.runtimeState?.sequence;
      const sameTransition =
        h.runtimeState?.state === input.state &&
        (input.sequence === undefined || input.sequence === h.runtimeState?.sequence);
      h.runtimeState = {
        ...(sequence === undefined ? {} : { sequence }),
        state: input.state,
        at: input.at.toISOString(),
        since:
          input.since ??
          (sameTransition
            ? (h.runtimeState?.since ?? h.runtimeState?.at ?? input.at.toISOString())
            : input.at.toISOString()),
      };
      return true;
    },
    async stopRuntime(input) {
      const h = handles.get(key(input.project, input.ticket));
      if (
        !h ||
        !OBSERVABLE_RUNTIMES.includes(runtimeNameOf(h.runtime) as "herdr" | "conductor") ||
        h.handle !== input.handle ||
        h.claimedAt !== input.claimedAt
      )
        return false;
      if (!h.releasedAt) {
        await this.releaseRuntimeHandle(input.project, input.ticket, input.at);
        await this.recordEvent({
          project: input.project,
          ticket: input.ticket,
          kind: "release",
          phase: "released",
          runtime: h.runtime,
          handle: h.handle,
          message: "Runtime workspace archived",
          at: input.at,
        });
      }
      return true;
    },
    async heartbeatTimes(project) {
      return Object.fromEntries(
        [...handles.values()]
          .filter((handle) => handle.project === project && !handle.releasedAt && handle.lastHeartbeatAt)
          .map((handle) => [handle.ticket, handle.lastHeartbeatAt as string]),
      );
    },
    async recordHeartbeat(input) {
      const handle = handles.get(key(input.project, input.ticket));
      if (
        !handle ||
        handle.releasedAt ||
        handle.handle !== input.handle ||
        (input.claimedAt && input.claimedAt !== handle.claimedAt) ||
        (handle.workerSessionId ?? null) !== (input.workerSessionId ?? null)
      )
        return { active: false, claimedAt: null };
      handle.lastHeartbeatAt = input.at.toISOString();
      const session = sessions.find(
        (session) =>
          session.project === input.project &&
          session.ticket === input.ticket &&
          session.handle === input.handle &&
          session.claimedAt === handle.claimedAt &&
          !session.releasedAt,
      );
      if (session) session.lastHeartbeatAt = handle.lastHeartbeatAt;
      await this.recordEvent({
        project: input.project,
        ticket: input.ticket,
        handle: input.handle,
        kind: "heartbeat",
        at: input.at,
      });
      return { active: true, claimedAt: handle.claimedAt };
    },
    async releaseRuntimeHandle(project, ticket, at, guard, merged = false) {
      const h = handles.get(key(project, ticket));
      if (guard?.absent) {
        if (h) return false;
        endReservations(project, ticket, at, merged);
        return true;
      }
      const guarded = !!(guard?.handle || guard?.claimedAt || guard?.workerSessionId);
      if (guarded && !h) {
        if (guard?.claimedAt) return false;
        endReservations(project, ticket, at, merged);
        return true;
      }
      if (
        guarded &&
        h &&
        ((guard?.handle && h.handle !== guard.handle) ||
          (guard?.claimedAt && h.claimedAt !== new Date(guard.claimedAt).toISOString()) ||
          (guard?.workerSessionId && h.workerSessionId && h.workerSessionId !== guard.workerSessionId))
      )
        return false;
      for (const session of sessions)
        if (
          session.project === project &&
          session.ticket === ticket &&
          !session.releasedAt &&
          (!guarded ||
            (h
              ? session.handle === h.handle && session.claimedAt === h.claimedAt
              : !guard?.handle || session.handle === guard.handle))
        )
          session.releasedAt = at.toISOString();
      if (h && !h.releasedAt) h.releasedAt = at.toISOString();
      profiles.delete(key(project, ticket));
      endReservations(project, ticket, at, merged);
      return true;
    },
    async openRuntimeHandles(project) {
      return [...handles.values()]
        .filter((h) => h.project === project && !h.releasedAt)
        .sort((a, b) => a.ticket.localeCompare(b.ticket))
        .map(handleOf);
    },
    async getRuntimeHandle(project, ticket) {
      const h = handles.get(key(project, ticket));
      return h ? handleOf(h) : null;
    },

    async addInboxItem(i) {
      return insert({
        project: i.project,
        ticket: i.ticket,
        kind: i.kind,
        recipient: i.recipient,
        author: i.author,
        coordinator: i.coordinator ?? null,
        body: i.body,
        createdAt: i.at.toISOString(),
        requestQuestion: null,
        requestProfile: null,
      });
    },
    async addRequest(r) {
      if (
        r.kind === "merge-request" &&
        items.some(
          (item) => item.project === r.project && item.kind === r.kind && item.requestPr === r.pr && !item.resolvedAt,
        )
      )
        return null;
      if (r.kind === "answer-request" || r.kind === "plan-changes") {
        const q = items.find((i) => i.project === r.project && i.id === r.question);
        if (!q || !["question", "plan"].includes(q.kind) || q.recipient !== "coordinator" || q.resolvedAt) return null;
        if (r.kind === "plan-changes" && q.kind !== "plan") return null;
        if (
          items.some(
            (i) => i.project === r.project && i.kind === r.kind && i.requestQuestion === r.question && !i.resolvedAt,
          )
        )
          return null;
      } else if (r.kind !== "merge-request" && open(r.project, r.ticket, r.kind)) return null;
      return insert({
        project: r.project,
        ticket: r.ticket,
        kind: r.kind,
        recipient: "coordinator",
        author: r.author,
        coordinator: r.coordinator ?? null,
        body: r.body,
        createdAt: r.at.toISOString(),
        requestQuestion: r.question,
        requestDeferred: r.deferred,
        deferredOptions: r.deferred
          ? {
              question: null,
              profile: r.profile,
              pinned: r.pinned ?? true,
              expiresAt: r.expiresAt ?? null,
              attempts: 0,
              attemptedAt: null,
              runtime: r.runtime ?? null,
              notes: r.notes ?? null,
              reason: r.reason ?? null,
            }
          : undefined,
        requestProfile: r.profile,
        requestPr: r.pr,
      });
    },
    async renewDeferredLaunch(r) {
      const was = open(r.project, r.ticket, "launch-request");
      if (!was?.requestDeferred || (was.coordinator ?? "default") !== (r.coordinator ?? "default")) return null;
      const previous = was.deferredOptions;
      was.requestProfile = r.profile ?? was.requestProfile;
      was.deferredOptions = {
        question: null,
        profile: was.requestProfile,
        pinned: r.profile ? (r.pinned ?? true) : (previous?.pinned ?? true),
        expiresAt: r.expiresAt,
        attempts: 0,
        attemptedAt: null,
        runtime: r.runtime ?? previous?.runtime,
        notes: r.notes ?? previous?.notes,
        reason: r.reason ?? previous?.reason,
      };
      return was.id;
    },
    async attemptDeferredLaunch(q) {
      const row = items.find((i) => i.project === q.project && i.id === q.id);
      if (!row || row.resolvedAt || !row.requestDeferred) return { ok: false, why: "request is closed or missing" };
      const data = row.deferredOptions ?? { question: null, profile: row.requestProfile };
      if (
        Date.parse(data.expiresAt ?? new Date(Date.parse(row.createdAt) + 7 * 86400000).toISOString()) <= q.at.getTime()
      )
        return { ok: false, why: "request expired" };
      if ((row.coordinator ?? "default") !== q.coordinator)
        return { ok: false, why: "request belongs to another coordinator" };
      if (data.attemptedAt && Date.parse(data.attemptedAt) > q.at.getTime() - q.backoffMinutes * 60000)
        return { ok: false, why: "request attempted too recently" };
      if ((data.attempts ?? 0) >= 3) return { ok: false, why: "request exhausted three attempts; renew it" };
      row.deferredOptions = { ...data, attempts: (data.attempts ?? 0) + 1, attemptedAt: q.at.toISOString() };
      return { ok: true, attempt: row.deferredOptions.attempts! };
    },
    async closeDeferredLaunches(q) {
      for (const t of q.tickets)
        for (const row of items)
          if (row.project === q.project && row.ticket === t.ticket && row.requestDeferred && !row.resolvedAt) {
            row.resolvedAt = q.at.toISOString();
            row.resolution = `ticket closed (${t.status})`;
          }
    },
    async putPlan(i) {
      const was = open(i.project, i.ticket, "plan");
      if (was) Object.assign(was, { body: i.body, author: i.author, createdAt: i.at.toISOString() });
      else await this.addInboxItem({ ...i, kind: "plan", recipient: "coordinator" });
    },
    async putHandBack(i) {
      const was = open(i.project, i.ticket, "hand-back");
      if (was) Object.assign(was, { body: i.body, author: i.author, createdAt: i.at.toISOString() });
      else await this.addInboxItem({ ...i, kind: "hand-back", recipient: "coordinator" });
    },
    async putChore(i) {
      const was = open(i.project, i.ticket, i.kind);
      if (was)
        Object.assign(was, {
          body: i.body,
          author: i.author,
          createdAt: i.at.toISOString(),
          requestPr: i.pr,
          coordinator: i.coordinator ?? null,
        });
      else {
        const id = await this.addInboxItem({ ...i, recipient: "coordinator" });
        const inserted = items.find((item) => item.id === id);
        if (inserted) inserted.requestPr = i.pr;
      }
    },
    async openInboxItems(q) {
      return items
        .filter(
          (i) =>
            i.project === q.project &&
            i.recipient === q.recipient &&
            !i.resolvedAt &&
            (!q.ticket || i.ticket === q.ticket),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
        .map(item);
    },
    async ackEntry(input) {
      checkAckOwner(input.project, input.ticket, input.coordinator);
      const k = `${input.project}\n${input.entryKey}`;
      if (acknowledgements.has(k)) return false;
      acknowledgements.set(k, {
        entryKey: input.entryKey,
        ticket: input.ticket,
        coordinator: input.coordinator,
        reason: input.reason,
        at: input.at.toISOString(),
      });
      return true;
    },
    async ackedKeys(project, entryKeys) {
      return [...new Set(entryKeys)]
        .map((entryKey) => acknowledgements.get(`${project}\n${entryKey}`))
        .filter((row): row is AckedEntry => !!row)
        .map((row) => ({ ...row }));
    },
    async getInboxItem(project, id) {
      const r = items.find((i) => i.project === project && i.id === id);
      return r ? stored(r) : null;
    },
    async resolveInboxItem(q) {
      if (q.ackCoordinator !== undefined) {
        const item = items.find((entry) => entry.project === q.project && entry.id === q.id);
        checkAckOwner(q.project, item?.ticket ?? null, q.ackCoordinator, item?.coordinator ?? null);
      }
      return (
        resolve(
          items.filter(
            (i) =>
              i.project === q.project &&
              i.id === q.id &&
              !i.resolvedAt &&
              (q.expectedBody === undefined || i.body === q.expectedBody),
          ),
          q.resolution,
          q.at,
        ) > 0
      );
    },
    async lastAnsweredAt(project, opts = {}) {
      const since = opts.since?.toISOString() ?? "";
      const out: Record<string, string> = {};
      for (const i of items)
        if (
          i.project === project &&
          ["question", "plan", "decision"].includes(i.kind) &&
          i.ticket &&
          i.resolvedAt &&
          i.resolvedAt >= since &&
          (!opts.tickets || opts.tickets.includes(i.ticket))
        )
          if (!out[i.ticket] || i.resolvedAt > (out[i.ticket] ?? "")) out[i.ticket] = i.resolvedAt;
      return out;
    },
    async resolveInboxItems(q) {
      return resolve(
        items.filter(
          (i) =>
            i.project === q.project &&
            i.ticket === q.ticket &&
            i.kind === q.kind &&
            !i.resolvedAt &&
            (q.author === undefined || (i.author === q.author && i.createdAt <= q.at.toISOString())),
        ),
        q.resolution,
        q.at,
      );
    },
    async resolvePrItems(q) {
      const found = items.filter(
        (i) =>
          i.project === q.project &&
          i.recipient === "coordinator" &&
          !i.resolvedAt &&
          ((i.kind === "queue-refused" && i.body.startsWith(queueRefusedPrefix(q.pr))) ||
            (i.kind === "merge-request" && i.requestPr === q.pr)),
      );
      resolve(found, q.resolution, q.at);
      return found.map((i) => i.id);
    },
    async resolveAnswerRequests(q) {
      return resolve(
        items.filter(
          (i) =>
            i.project === q.project && i.kind === "answer-request" && !i.resolvedAt && i.requestQuestion === q.question,
        ),
        q.resolution,
        q.at,
      );
    },
    async resolvePlans(q) {
      const plans = items.filter(
        (i) => i.project === q.project && i.ticket === q.ticket && i.kind === "plan" && !i.resolvedAt,
      );
      const ids = new Set(plans.map((p) => p.id));
      resolve(
        items.filter(
          (i) =>
            i.project === q.project &&
            i.kind === "answer-request" &&
            !i.resolvedAt &&
            i.requestQuestion !== null &&
            ids.has(i.requestQuestion),
        ),
        q.resolution,
        q.at,
      );
      return resolve(plans, q.resolution, q.at);
    },

    async queueAdd(e) {
      const existing = queue.find((r) => r.project === e.project && r.pr === e.pr && queueOpen(r));
      if (existing) return { existing: structuredClone(existing) };
      const { at, ...input } = e;
      const entry: QueueEntry = {
        ...input,
        id: queue.length + 1,
        state: "queued",
        detail: null,
        attempts: 0,
        notBefore: null,
        queuedAt: at.toISOString(),
        updatedAt: at.toISOString(),
        mergeCommit: null,
        finishedAt: null,
      };
      queue.push(entry);
      resolve(
        items.filter(
          (i) =>
            i.project === e.project &&
            i.kind === "queue-refused" &&
            !i.resolvedAt &&
            i.body.startsWith(queueRefusedPrefix(e.pr)),
        ),
        `resolved: PR #${e.pr} queued again`,
        at,
      );
      return {
        id: entry.id,
        position: queue.filter(
          (r) =>
            r.project === e.project &&
            queueOpen(r) &&
            (r.queuedAt < entry.queuedAt || (r.queuedAt === entry.queuedAt && r.id <= entry.id)),
        ).length,
      };
    },
    async queueList(project, { since }) {
      return structuredClone(
        queue
          .filter(
            (r) => r.project === project && (queueOpen(r) || (r.finishedAt && r.finishedAt >= since.toISOString())),
          )
          .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id - b.id),
      );
    },
    async queueNext(q) {
      const held = leases.get(key(q.project, MERGE_QUEUE_LEASE)) ?? null;
      if (!held || held.holder !== q.holder || Date.parse(held.expiresAt) <= q.at.getTime())
        return { refused: true, held };
      const entries = queue
        .filter((r) => r.project === q.project && queueOpen(r))
        .sort(
          (a, b) =>
            Number(b.state === "merging") - Number(a.state === "merging") ||
            a.queuedAt.localeCompare(b.queuedAt) ||
            a.id - b.id,
        );
      const first = entries[0];
      const entry =
        first?.state === "queued" && first.notBefore && first.notBefore > q.at.toISOString() ? undefined : first;
      if (entry) {
        entry.state = "merging";
        entry.updatedAt = q.at.toISOString();
      }
      return { entry: entry ? structuredClone(entry) : null, holds: [] };
    },
    async queueFinish(q) {
      const held = leases.get(key(q.project, MERGE_QUEUE_LEASE));
      if (!held || held.holder !== q.holder || Date.parse(held.expiresAt) <= q.at.getTime()) return false;
      const entry = queue.find((r) => r.project === q.project && r.id === q.id && r.state === "merging");
      if (!entry) return false;
      Object.assign(entry, {
        state: q.outcome === "retry" || q.outcome === "paused" ? "queued" : q.outcome,
        detail: q.detail,
        updatedAt: q.at.toISOString(),
        attempts: entry.attempts + (q.outcome === "retry" ? 1 : 0),
        notBefore: q.outcome === "retry" ? (q.notBefore ?? null) : null,
        mergeCommit: q.mergeCommit ?? null,
        finishedAt: q.outcome === "retry" || q.outcome === "paused" ? null : q.at.toISOString(),
      });
      if (q.outcome === "refused")
        await this.addInboxItem({
          project: q.project,
          ticket: entry.ticket,
          kind: "queue-refused",
          recipient: "coordinator",
          author: q.holder,
          body: `${queueRefusedPrefix(entry.pr)} ${q.detail ?? "merge refused"}`,
          at: q.at,
        });
      if (q.outcome === "merged")
        await this.resolvePrItems({
          project: q.project,
          pr: entry.pr,
          resolution: `resolved: PR #${entry.pr} merged`,
          at: q.at,
        });
      return true;
    },
    async queueProgress(q) {
      const held = leases.get(key(q.project, MERGE_QUEUE_LEASE));
      if (!held || held.holder !== q.holder || Date.parse(held.expiresAt) <= q.at.getTime()) return false;
      const entry = queue.find((r) => r.project === q.project && r.id === q.id && r.state === "merging");
      if (!entry) return false;
      Object.assign(entry, { detail: q.detail, updatedAt: q.at.toISOString() });
      return true;
    },
    async queueRemove(q) {
      const entry = queue.find((r) => r.project === q.project && r.pr === q.pr && r.state === "queued");
      if (!entry) return false;
      entry.state = "removed";
      entry.updatedAt = q.at.toISOString();
      entry.finishedAt = q.at.toISOString();
      return true;
    },
    async acquireLease(l) {
      const k = key(l.project, l.name);
      const held = leases.get(k);
      if (held && held.holder !== l.holder && Date.parse(held.expiresAt) > l.at.getTime())
        return { acquired: false, held: { ...held } };
      leases.set(k, {
        project: l.project,
        name: l.name,
        holder: l.holder,
        acquiredAt: held?.holder === l.holder ? held.acquiredAt : l.at.toISOString(),
        expiresAt: new Date(l.at.getTime() + l.ttlMs).toISOString(),
      });
      return { acquired: true };
    },
    async getLease(project, name) {
      const l = leases.get(key(project, name));
      return l ? { ...l } : null;
    },
    async renewLease(l) {
      const held = leases.get(key(l.project, l.name));
      if (!held || held.holder !== l.holder) return false;
      held.expiresAt = new Date(l.at.getTime() + l.ttlMs).toISOString();
      return true;
    },
    async releaseLease(l) {
      const k = key(l.project, l.name);
      if (leases.get(k)?.holder === l.holder) leases.delete(k);
    },

    async pendingLaunches(project, since, opts = {}) {
      const held = (ticket: string) => {
        const h = handles.get(key(project, ticket));
        return !!h && !h.releasedAt;
      };
      const newest = new Map<string, LaunchRow>();
      for (const l of launches)
        if (l.project === project && l.launchedAt >= since.toISOString()) {
          const was = newest.get(l.ticket);
          if (!was || l.launchedAt > was.launchedAt) newest.set(l.ticket, l);
        }
      return [...newest.values()]
        .filter(
          (l) =>
            opts.history ||
            (!l.endedAt &&
              !held(l.ticket) &&
              !events.some(
                (e) => e.project === project && e.ticket === l.ticket && e.kind === "claim" && e.at >= l.launchedAt,
              )),
        )
        .sort((a, b) => a.launchedAt.localeCompare(b.launchedAt))
        .map(({ id, ticket, launchedAt, tokenUsedAt, tokenExpiresAt, runtime, handle, coordinator, overCap }) => ({
          ...(id ? { id } : {}),
          coordinator: coordinator ?? null,
          overCap: overCap ?? null,
          ticket,
          launchedAt,
          tokenUsedAt,
          tokenExpiresAt,
          runtime,
          handle,
        }));
    },

    async expireUnusedLaunches(project, now, coordinatorName) {
      const pending = await this.pendingLaunches(project, new Date(0));
      const expired = pending.filter(
        (launch) =>
          unusedLaunchExpired(launch, now) &&
          !items.some(
            (notice) =>
              notice.project === project &&
              notice.ticket === launch.ticket &&
              !notice.resolvedAt &&
              ((notice.kind === "launch-uncertain" && notice.launchId === launch.id) ||
                (notice.kind === "launch-request" && notice.requestDeferred)),
          ) &&
          (!coordinatorName || launch.coordinator == null || launch.coordinator === coordinatorName),
      );
      for (const launch of expired) {
        const row = launches.find(
          (candidate) =>
            candidate.project === project &&
            candidate.ticket === launch.ticket &&
            candidate.launchedAt === launch.launchedAt,
        );
        if (row) row.endedAt = now.toISOString();
      }
      return expired;
    },

    async requestSecret(input) {
      const open = validations.find(
        (v) => v.project === input.project && v.kind === "secret" && v.secretName === input.name && !v.decision,
      );
      if (open) return { state: "requested", validation: copy(open) };
      const validation = await this.addValidation({
        project: input.project,
        ticket: input.ticket,
        kind: "secret",
        secretName: input.name,
        what: `Set ${input.name}`,
        reason: input.reason,
        choices: null,
        pr: null,
        attachments: [],
        author: input.author,
        at: input.at,
      });
      return { state: "requested", validation };
    },
    async addValidation(v) {
      const at = v.at.toISOString();
      for (const was of validations)
        if (
          was.project === v.project &&
          !was.decision &&
          was.kind === v.kind &&
          ((v.kind === "merge" && was.pr?.number === v.pr?.number) ||
            (v.kind === "validation" && was.ticket === v.ticket))
        )
          was.decision = { outcome: "superseded", answer: null, note: null, by: null, at };
      const { at: _at, ...rest } = v;
      const row: Validation = { ...rest, id: validations.length + 1, createdAt: at, decision: null };
      validations.push(row);
      return copy(row);
    },
    async listValidations(q) {
      const since = q.decidedSince?.toISOString() ?? "";
      return validations
        .filter(
          (v) =>
            v.project === q.project &&
            (q.ticket === undefined || v.ticket === q.ticket) &&
            (q.pr === undefined || v.pr?.number === q.pr) &&
            (!v.decision || v.decision.at >= since),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
        .map(copy);
    },
    async getValidation(project, id) {
      const v = validations.find((x) => x.project === project && x.id === id);
      return v ? copy(v) : null;
    },
    async decideValidation(d) {
      const v = validations.find((x) => x.project === d.project && x.id === d.id);
      if (!v || v.decision) return null;
      v.decision = { ...d.decision, at: d.at.toISOString() };
      const item = insert({
        project: d.project,
        ticket: v.ticket,
        kind: "decision",
        recipient: "coordinator",
        author: d.decision.by,
        body: d.body,
        createdAt: d.at.toISOString(),
        requestQuestion: null,
        requestProfile: null,
        requestValidation: v.id,
      });
      return { item };
    },
  };
}
