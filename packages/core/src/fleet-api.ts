// The fleet's live data through the Armada API (THE-850): both halves of
// `POST /api/cli/fleet/<operation>`. The CLI's half (`fleetClient`) sends each
// command's record, for one project, with the terminal's sign-in; the app's
// half (`serveFleet`) checks it and runs it on the fleet's database, with the
// server's clock. A worker session only claims, reports, asks and releases its
// own ticket. Every request names the whole project (slug, name, repository,
// root): the app registers it on first contact, for the caller's organization.
// No error quotes a token.

import type { ArmadaApi, ArmadaSignIn } from "./armada-api.ts";
import type { ArmadaConfig } from "./config.ts";
import { type DeferredLaunch, deferredHeld, deferredLaunchState } from "./deferred.ts";
import { buildDigest, type Digest, renderDigest } from "./digest.ts";
import { attachPullRequests } from "./github.ts";
import { JOB_NAME, JOB_PROGRESS_MAX, JOB_REF_MAX, JOB_STATES, type Job, type JobState } from "./jobs.ts";
import type { CoordinatorFacts } from "./live.ts";
import {
  type AnswerRecord,
  type ClaimRecord,
  type CoordinatorRecord,
  type EventsRead,
  eventCursor,
  type Fleet,
  type FleetStore,
  FOLLOW_EVENT_KINDS,
  followedLaunches,
  type HandBackSnapshot,
  holdsNext,
  holdsPaused,
  type InboxItem,
  type InboxQuery,
  type InboxRead,
  LAUNCH_WINDOW_MS,
  type LatestEvent,
  type LeaseResult,
  MERGE_LEASE,
  type MergeRecord,
  type MergeRecorded,
  type PendingLaunch,
  type ProjectInput,
  parseEventCursor,
  type ReportRecord,
  type ReportResult,
  type Reservation,
  RUNTIME_STATES,
  type RuntimeState,
  readOverlap,
  recordAnswer,
  recordClaim,
  recordDone,
  recordMerge,
  recordQuestion,
  recordRelease,
  recordReport,
  recordValidation,
  type StoredInboxItem,
  serveInbox,
  type ValidationRecord,
  type WorkerProfile,
} from "./live.ts";
import type { QueueAdded, QueueEntry, QueueNext } from "./merge-queue.ts";
import { buildModel } from "./model.ts";
import { type OverlapReading, pathsProblem } from "./overlap.ts";
import { isLabelPhase } from "./phases.ts";
import { RequestRefusal, requestDeferredLaunch, requestMerge, requestPlanChanges, requestRelease } from "./requests.ts";
import { runtimeNameOf } from "./runtime.ts";
import type { CiState, LabelPhase } from "./types.ts";
import { isShippingStage } from "./types.ts";
import {
  approvalUrl,
  VALIDATION_KINDS,
  VALIDATION_LIMITS,
  type Validation,
  type ValidationKind,
  type ValidationPr,
} from "./validations.ts";

/** The operations a worker session may run, on its own ticket only. */
export const WORKER_FLEET_OPS = [
  "claim",
  "report",
  "ask",
  "release",
  "heartbeat",
  "validate",
  "overlap",
  "job/start",
  "job/observe",
  "job/list",
  "reserve",
  "reservations",
  "unreserve",
] as const;

/** Every operation, as the path after `/api/cli/fleet/`. */
export const FLEET_OPS = [
  ...WORKER_FLEET_OPS,
  "holds",
  "hold/open",
  "hold/clear",

  "digest",
  "digest/send",
  "register",
  "coordinator",
  "coordinators",
  "coordinators/take",
  "request",
  "events/latest",
  "events/state",
  "events/since",
  "heartbeats/latest",
  "runtime/handles",
  "runtime/handle",
  "runtime/reference",
  "runtime/observe",
  "runtime/stop",
  "launches",
  "launch-requests",
  "inbox",
  "inbox/item",
  "inbox/ticket",
  "inbox/resolve",
  "answer",
  "merge",
  "validations",
  "done",
  "queue/add",
  "queue/list",
  "queue/next",
  "queue/finish",
  "queue/remove",
  "lease/acquire",
  "lease/renew",
  "lease/release",
] as const;
export type FleetOp = (typeof FLEET_OPS)[number];

/** A lease lasts at most this long: a crashed coordinator never holds the merge lock for good. */
export const LEASE_TTL_MAX_MS = 60 * 60_000;

/** Who calls: a terminal of the project's organization, or a worker session bound to one ticket. */
export type FleetCaller =
  | { kind: "organization"; author?: string | null; launchAuthor?: string | null }
  | { kind: "worker"; ticket: string; sessionId?: string; coordinator?: string | null };

export interface FleetAnswer {
  status: number;
  body: Record<string, unknown>;
}

export const COORDINATOR = /^[a-z0-9][a-z0-9-]{0,31}$/;

const TICKET = /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/;
// The project as armada.toml allows it (`config.ts`), within lengths no real project reaches.
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;
const ROOT = /^[A-Za-z][A-Za-z0-9]{0,63}-\d{1,12}$/;
const REPOSITORY = /^[\w.-]{1,200}\/[\w.-]{1,200}$/;
const SHA = /^[0-9a-f]{7,64}$/;

/** A request the server will not run as sent. */
class Invalid extends Error {}
class JobScopeError extends Error {}
class Held extends Error {
  constructor(
    message: string,
    readonly next: string,
  ) {
    super(message);
  }
}

type Body = Record<string, unknown>;

const objectOf = (v: unknown): Body =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Body) : ({} as Body);

function text(b: Body, key: string, max: number): string {
  const v = b[key];
  if (typeof v !== "string" || !v.trim()) throw new Invalid(`${key} is required`);
  if (v.length > max) throw new Invalid(`${key} has at most ${max} characters`);
  return v;
}

function optText(b: Body, key: string, max: number): string | null {
  const v = b[key];
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") throw new Invalid(`${key} must be text`);
  if (v.length > max) throw new Invalid(`${key} has at most ${max} characters`);
  return v;
}

function coordinatorNameOf(b: Body, key = "coordinatorName", fallback = "default"): string {
  const name = b[key] === undefined ? fallback : b[key];
  if (typeof name !== "string" || !COORDINATOR.test(name)) throw new Invalid(`${key} must match ${COORDINATOR.source}`);
  return name;
}

function pathsOf(b: Body): string[] {
  const problem = pathsProblem(b.paths);
  if (problem) throw new Invalid(problem);
  return [...new Set(b.paths as string[])];
}

function ticketOf(b: Body, key = "ticket"): string {
  const v = b[key];
  if (typeof v !== "string" || !TICKET.test(v)) throw new Invalid(`${key} must be a ticket id such as ABC-12`);
  return v.toUpperCase();
}

function idOf(b: Body, key: string): number {
  const v = b[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new Invalid(`${key} must be an item id`);
  return v;
}

function bool(b: Body, key: string): boolean {
  const v = b[key];
  if (typeof v !== "boolean") throw new Invalid(`${key} must be true or false`);
  return v;
}

function shippingStageOf(b: Body) {
  const stage = b.shippingStage;
  if (stage == null) return null;
  if (b.phase !== "shipping" || !isShippingStage(stage))
    throw new Invalid("shippingStage requires shipping and must be review or ci");
  return stage;
}

function phaseOf(b: Body, key: string, optional = false): LabelPhase | null {
  const v = b[key];
  if (optional && (v === null || v === undefined)) return null;
  if (typeof v !== "string" || !isLabelPhase(v)) throw new Invalid(`${key} must be an agent phase`);
  return v;
}

function shaOf(b: Body, key: string): string | null {
  const v = optText(b, key, 64);
  if (v !== null && !SHA.test(v)) throw new Invalid(`${key} must be a commit SHA`);
  return v;
}

function dateOf(b: Body, key: string): string {
  const value = text(b, key, 64);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Invalid(`${key} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

const BODY_MAX = 100_000;
const LINE_MAX = 500;
const URL_MAX = 2_000;

/** The project a request names, checked; null when it names none or a malformed one. */
export function parseProject(v: unknown): ProjectInput | null {
  const p = objectOf(v);
  const ok =
    typeof p.slug === "string" &&
    SLUG.test(p.slug) &&
    typeof p.name === "string" &&
    p.name.trim().length > 0 &&
    p.name.length <= 500 &&
    typeof p.repository === "string" &&
    REPOSITORY.test(p.repository) &&
    typeof p.programRoot === "string" &&
    ROOT.test(p.programRoot);
  return ok
    ? {
        slug: p.slug as string,
        name: p.name as string,
        repository: p.repository as string,
        programRoot: (p.programRoot as string).toUpperCase(),
      }
    : null;
}

export const isFleetOp = (v: string): v is FleetOp => (FLEET_OPS as readonly string[]).includes(v);
export const isWorkerFleetOp = (v: string) => (WORKER_FLEET_OPS as readonly string[]).includes(v);

function profileOf(v: unknown): WorkerProfile | null {
  if (v === null || v === undefined) return null;
  const p = objectOf(v);
  return {
    name: text(p, "name", LINE_MAX),
    agent: text(p, "agent", LINE_MAX),
    model: text(p, "model", LINE_MAX),
    effort: text(p, "effort", LINE_MAX),
    fastMode: bool(p, "fastMode"),
    routed: optText(p, "routed", LINE_MAX),
    reason: optText(p, "reason", BODY_MAX),
    why: text(p, "why", BODY_MAX),
  };
}

const refuse = (status: number, error: string, next: string): FleetAnswer => ({ status, body: { error, next } });

/** An inbox read whose entries did not change: answered 304, with no body. */
const NOT_MODIFIED = Symbol("not modified");
const TRANSFER_REFUSED = Symbol("transfer refused");

export interface ServeFleetDeps {
  sendDigest?: (project: string, digest: Digest, language: "en" | "fr", now: Date) => Promise<boolean>;
  /** Stored project facts, supplied by the host, never by the caller. */
  snapshot?: HandBackSnapshot;
  config?: ArmadaConfig;
  now: () => Date;
  /** The dashboard's address, for the approval links (THE-885); a relative link without it. */
  appUrl?: string | null;
  /** The caller's CLI version (`x-armada-cli-version`): the coordinator's presence keeps it. */
  cliVersion?: string | null;
}

/** A CLI version as a release names it (0.2.4, 1.0.0-beta.1); anything else is not kept. */
const CLI_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][\w.-]{1,40})?$/;

/**
 * Runs one operation for `project`, already registered for the caller's
 * organization by the host. Answers `{ result }`; 304 with no body for an
 * inbox read whose entries did not change; or a refusal with the next step:
 * 400 for a malformed request, 403 beyond a worker's scope. Every operation
 * is a few indexed reads and writes of the fleet's database, with nothing
 * held open and no call to Linear or GitHub.
 */
export async function serveFleet(
  store: FleetStore,
  req: { op: string; project: ProjectInput; caller: FleetCaller; input: unknown },
  deps: ServeFleetDeps & { openPrs?: readonly number[] },
): Promise<FleetAnswer> {
  const { op, project, caller } = req;
  if (!isFleetOp(op))
    return refuse(404, `no fleet operation ${op}`, "update the CLI: npm install -g @the-vibe-company/armada");
  const b = objectOf(req.input);
  const slug = project.slug;
  const at = deps.now();
  try {
    if (caller.kind === "worker") {
      const ticket = op === "job/list" && b.ticket == null ? caller.ticket : isWorkerFleetOp(op) ? ticketOf(b) : null;
      if (ticket !== caller.ticket)
        return refuse(
          403,
          ["reserve", "reservations", "unreserve"].includes(op)
            ? `a worker session only reserves resources for its own ticket (${caller.ticket}), not ${ticket}`
            : `a worker session only claims, reports, asks, validates and releases its own ticket (${caller.ticket}), not ${ticket ? `${ticket}` : `\`${op}\``}`,
          "the coordinator does it",
        );
    }
    const coordinatorName =
      caller.kind === "worker"
        ? (caller.coordinator ?? null)
        : coordinatorNameOf(
            b,
            b.coordinatorName === undefined &&
              op !== "inbox" &&
              op !== "runtime/reference" &&
              b.coordinator !== undefined
              ? "coordinator"
              : op === "coordinator" && b.coordinatorName === undefined && b.name !== undefined
                ? "name"
                : "coordinatorName",
          );
    const result = await (async (): Promise<unknown> => {
      switch (op) {
        case "job/start": {
          const name = text(b, "name", 64);
          if (!JOB_NAME.test(name) || name === "__proto__") throw new Invalid("name must be a configured job name");
          return store.startJob({
            project: slug,
            ticket: ticketOf(b),
            name,
            startedBy: caller.kind === "worker" ? (caller.sessionId ?? caller.ticket) : (caller.author ?? null),
            at,
          });
        }
        case "job/list":
          return store.listJobs(slug, {
            ...(b.ticket == null
              ? caller.kind === "worker"
                ? { ticket: caller.ticket }
                : {}
              : { ticket: ticketOf(b) }),
            ...(b.open === undefined ? {} : { open: bool(b, "open") }),
            ...(b.id === undefined ? {} : { id: idOf(b, "id") }),
          });
        case "job/observe": {
          const id = idOf(b, "id");
          const ticket = ticketOf(b);
          const job = await store.getJob(slug, id);
          if (!job || job.ticket !== ticket) throw new JobScopeError();
          if (!JOB_STATES.includes(b.state as JobState) || b.state === "starting")
            throw new Invalid("unknown job observation state");
          const ref = b.ref === undefined ? undefined : optText(b, "ref", JOB_REF_MAX);
          if (ref !== undefined && job.ref !== null && ref !== job.ref)
            throw new Invalid("runner reference is already recorded and cannot change");
          const eta = optText(b, "eta", 40);
          if (eta !== null && !Number.isFinite(Date.parse(eta))) throw new Invalid("eta must be a timestamp");
          return store.observeJob({
            project: slug,
            id,
            ticket,
            state: b.state as Exclude<JobState, "starting">,
            ...(ref === undefined ? {} : { ref }),
            progress: optText(b, "progress", JOB_PROGRESS_MAX),
            eta: eta === null ? null : new Date(eta).toISOString(),
            at,
          });
        }
        case "digest":
        case "digest/send": {
          const since = optText(b, "since", 40);
          if (since !== null && (!Number.isFinite(Date.parse(since)) || Date.parse(since) > at.getTime()))
            throw new Invalid("since must be a timestamp no later than now");
          if (b.language !== undefined && b.language !== "en" && b.language !== "fr")
            throw new Invalid("language must be en or fr");
          if (op === "digest/send" && !deps.sendDigest)
            throw new Invalid("No notification channel available; configure Organization > Notifications");
          const records = await store.digestRecords(slug, since, at);
          const digest = buildDigest(records.input);
          const language = (b.language ?? records.language) as "en" | "fr";
          const text = renderDigest(digest, { language, format: "plain", appUrl: deps.appUrl ?? "http://localhost" });
          const sent = op === "digest/send" ? ((await deps.sendDigest?.(slug, digest, language, at)) ?? false) : false;
          if (op === "digest/send" && !sent)
            throw new Invalid("Digest not delivered; check Organization > Notifications");
          return { digest, text, sent };
        }
        case "reservations":
          return store.reservations(slug);
        case "reserve": {
          const next = b.next === undefined ? false : bool(b, "next");
          if (b.value !== undefined && (typeof b.value !== "string" || b.value.length > LINE_MAX))
            throw new Invalid("value must be text of at most 500 characters");
          if (next && b.value !== undefined) throw new Invalid("use next or value, not both");
          if (
            b.floor !== undefined &&
            (!next ||
              typeof b.floor !== "number" ||
              !Number.isSafeInteger(b.floor) ||
              b.floor < 0 ||
              b.floor >= Number.MAX_SAFE_INTEGER)
          )
            throw new Invalid("floor requires next and must be a nonnegative safe integer below the maximum");
          return store.reserve({
            project: slug,
            ticket: ticketOf(b),
            key: text(b, "key", LINE_MAX),
            ...(b.value === undefined ? {} : { value: b.value as string }),
            next,
            ...(b.floor === undefined ? {} : { floor: b.floor as number }),
            note: optText(b, "note", BODY_MAX),
            at,
          });
        }
        case "unreserve":
          return store.unreserve({ project: slug, ticket: ticketOf(b), key: text(b, "key", LINE_MAX), at });
        case "claim":
          return recordClaim(
            store,
            slug,
            {
              ticket: ticketOf(b),
              runtime: text(b, "runtime", LINE_MAX),
              handle: text(b, "handle", LINE_MAX),
              branch: optText(b, "branch", LINE_MAX),
              phase: phaseOf(b, "phase", true),
              resuming: bool(b, "resuming"),
              profile: profileOf(b.profile),
              workerSessionId: caller.kind === "worker" ? caller.sessionId : null,
              coordinator: coordinatorName,
            },
            at,
          );
        case "overlap":
          return readOverlap(store, slug, ticketOf(b), pathsOf(b), at, deps.snapshot);
        case "report":
          return recordReport(
            store,
            slug,
            {
              ticket: ticketOf(b),
              phase: phaseOf(b, "phase") as LabelPhase,
              shippingStage: shippingStageOf(b),
              previous: phaseOf(b, "previous", true),
              ...(b.paths !== undefined ? { paths: pathsOf(b) } : {}),
              summary: text(b, "summary", BODY_MAX),
              message: optText(b, "message", BODY_MAX) ?? "",
              prUrl: optText(b, "prUrl", URL_MAX),
              // Checked by the CLI for a hand-back only; any other report keeps what it was given.
              headSha: optText(b, "headSha", LINE_MAX),
            },
            at,
            deps.snapshot,
          );
        case "ask":
          return recordQuestion(store, slug, { ticket: ticketOf(b), body: text(b, "body", BODY_MAX) }, at);
        case "release": {
          const claimedAt = optText(b, "claimedAt", 40);
          if (claimedAt && !Number.isFinite(Date.parse(claimedAt))) throw new Invalid("claimedAt must be a timestamp");
          return recordRelease(
            store,
            slug,
            {
              ticket: ticketOf(b),
              reason: text(b, "reason", BODY_MAX),
              handle: optText(b, "handle", LINE_MAX),
              claimedAt,
              workerSessionId: caller.kind === "worker" ? caller.sessionId : null,
            },
            at,
          );
        }
        case "holds":
          return store.openHolds(slug);
        case "hold/open": {
          if (!["manual", "deploy", "main-red"].includes(String(b.kind)))
            throw new Invalid("kind must be manual, deploy or main-red");
          const kind = b.kind as import("./live.ts").HoldKind;
          const ref = kind === "manual" ? null : text(b, "ref", LINE_MAX).trim();
          return store.openHold({
            project: slug,
            kind,
            ref,
            reason: text(b, "reason", BODY_MAX).trim(),
            author: caller.kind === "organization" ? (caller.author ?? null) : null,
            at,
          });
        }
        case "hold/clear":
          return store.clearHold({
            project: slug,
            id: idOf(b, "id"),
            reason: text(b, "reason", BODY_MAX).trim(),
            author: caller.kind === "organization" ? (caller.author ?? null) : null,
            at,
          });
        case "register":
          return store.upsertProject(
            { ...project, owner: caller.kind === "organization" ? (caller.author ?? null) : null },
            at,
          );
        case "coordinator":
          return store.recordCoordinatorSeen({
            project: slug,
            name: coordinatorName ?? "default",
            facts: { ...coordinatorFacts(b), name: coordinatorName ?? "default" },
            inboxRead: false,
            at,
          });
        case "coordinators":
          return store.listCoordinators(slug);
        case "coordinators/take": {
          if (!Array.isArray(b.tickets) || b.tickets.length < 1 || b.tickets.length > 100)
            throw new Invalid("tickets must contain 1 to 100 ticket ids");
          const tickets = [...new Set(b.tickets.map((ticket) => ticketOf({ ticket })))];
          const from = b.from === undefined ? undefined : coordinatorNameOf(b, "from");
          const taken = await store.transferTickets({
            project: slug,
            tickets,
            to: coordinatorName ?? "default",
            from,
            at,
          });
          if (!taken) return TRANSFER_REFUSED;
          return true;
        }
        case "request": {
          const common = {
            project: slug,
            coordinator: coordinatorName,
            author: caller.kind === "organization" ? (caller.author ?? "coordinator") : "",
            now: at,
          };
          if (b.kind === "launch-when-unblocked") {
            if (!deps.config || !deps.snapshot?.flight)
              throw new RequestRefusal(
                "not-ready",
                "no stored reading of the project yet; open its dashboard and retry",
              );
            return requestDeferredLaunch(store, {
              config: deps.config,
              snapshot: deps.snapshot,
              ticket: ticketOf(b),
              profile: optText(b, "profile", LINE_MAX),
              after: b.after == null ? null : ticketOf(b, "after"),
              author: caller.kind === "organization" ? (caller.launchAuthor ?? caller.author ?? "") : "",
              coordinator: coordinatorName,
              now: at,
            });
          }
          if (b.kind === "merge-request")
            return requestMerge(store, { ...common, pr: idOf(b, "pr"), openPrs: deps.openPrs ?? [] });
          if (b.kind === "release-request") return requestRelease(store, { ...common, ticket: ticketOf(b) });
          if (b.kind === "plan-changes")
            return requestPlanChanges(store, {
              ...common,
              question: idOf(b, "question"),
              text: text(b, "text", BODY_MAX),
            });
          throw new Invalid("unknown request kind");
        }
        case "events/since": {
          let cursor: ReturnType<typeof parseEventCursor>;
          try {
            cursor = parseEventCursor(eventCursor(Number(b.afterId), String(b.afterAt)));
          } catch {
            throw new Invalid("invalid events cursor");
          }
          if (typeof b.afterId !== "number") throw new Invalid("afterId must be a number");
          if (!Array.isArray(b.kinds) || !b.kinds.length || b.kinds.some((k) => !FOLLOW_EVENT_KINDS.includes(k)))
            throw new Invalid("kinds must name claim, report, release or merge");
          if (b.handoverOnly !== undefined && typeof b.handoverOnly !== "boolean")
            throw new Invalid("handoverOnly must be true or false");
          const tickets = b.tickets;
          if (
            tickets !== undefined &&
            (!Array.isArray(tickets) ||
              tickets.length > 200 ||
              tickets.some((t) => typeof t !== "string" || !TICKET.test(t)))
          )
            throw new Invalid("tickets must be a list of ticket identifiers");
          const limit = b.limit ?? 200;
          if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)
            throw new Invalid("limit must be between 1 and 200");
          const seenIds = b.seenIds;
          if (
            seenIds !== undefined &&
            (!Array.isArray(seenIds) ||
              seenIds.length > 500 ||
              seenIds.some((id) => !Number.isSafeInteger(id) || id <= 0))
          )
            throw new Invalid("seenIds must contain at most 500 event IDs");
          let pageAfter: { id: number; at: string } | undefined;
          if (b.pageAfter !== undefined) {
            const page = objectOf(b.pageAfter);
            try {
              const p = parseEventCursor(eventCursor(Number(page.id), String(page.at)));
              pageAfter = { id: p.afterId, at: p.afterAt };
            } catch {
              throw new Invalid("invalid page cursor");
            }
          }
          const events = await store.eventsSince(slug, {
            ...cursor,
            kinds: b.kinds,
            handoverOnly: b.handoverOnly,
            tickets,
            limit,
            seenIds,
            pageAfter,
          });
          if (!events.length) return NOT_MODIFIED;
          const last = events[events.length - 1];
          const advanced =
            last && (last.at > cursor.afterAt || (last.at === cursor.afterAt && last.id > cursor.afterId));
          return {
            events,
            cursor: advanced ? eventCursor(last.id, last.at) : eventCursor(cursor.afterId, cursor.afterAt),
          };
        }
        case "events/state":
          return store.latestEvents(slug);
        case "events/latest":
          return store.lastEventTimes(slug);
        case "heartbeats/latest":
          return store.heartbeatTimes(slug);
        case "runtime/handles":
          return store.openRuntimeHandles(slug);
        case "runtime/handle":
          return store.getRuntimeHandle(slug, ticketOf(b));
        case "runtime/reference": {
          const claimedAt = optText(b, "claimedAt", 40);
          if (claimedAt && !Number.isFinite(Date.parse(claimedAt))) throw new Invalid("claimedAt must be a timestamp");
          const runtime = runtimeNameOf(text(b, "runtime", 32));
          if (!runtime) throw new Invalid("unknown runtime");
          return store.getRuntimeReference(slug, {
            ticket: ticketOf(b),
            runtime,
            handle: text(b, "handle", LINE_MAX),
            claimedAt,
            launchId: optText(b, "launchId", LINE_MAX),
            releasedAt: null,
          });
        }
        case "runtime/observe":
        case "runtime/stop": {
          const claimedAt = text(b, "claimedAt", 40);
          if (!Number.isFinite(Date.parse(claimedAt))) throw new Invalid("claimedAt must be a timestamp");
          const input = { project: slug, ticket: ticketOf(b), handle: text(b, "handle", LINE_MAX), claimedAt, at };
          if (op === "runtime/stop") return store.stopRuntime(input);
          if (!RUNTIME_STATES.includes(b.state as RuntimeState)) throw new Invalid("unknown runtime state");
          const since = optText(b, "since", 40);
          if (since !== null && (!Number.isFinite(Date.parse(since)) || Date.parse(since) > at.getTime()))
            throw new Invalid("since must be a timestamp no later than the observation");
          const sequence = b.sequence;
          if (
            sequence !== undefined &&
            (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0)
          )
            throw new Invalid("sequence must be a nonnegative safe integer");
          return store.observeRuntime({
            ...input,
            state: b.state as RuntimeState,
            ...(since === null ? {} : { since }),
            ...(sequence === undefined ? {} : { sequence }),
          });
        }
        case "heartbeat": {
          const claimedAt = optText(b, "claimedAt", 40);
          if (claimedAt && !Number.isFinite(Date.parse(claimedAt))) throw new Invalid("claimedAt must be a timestamp");
          const result = await store.recordHeartbeat({
            project: slug,
            ticket: ticketOf(b),
            handle: text(b, "handle", LINE_MAX),
            claimedAt,
            workerSessionId: caller.kind === "worker" ? caller.sessionId : null,
            at,
          });
          if (!result.active || !result.claimedAt) return result;
          const [events, profile] = await Promise.all([
            store.latestEvents(slug, { since: new Date(result.claimedAt) }),
            store.getWorkerProfile(slug, ticketOf(b)),
          ]);
          return {
            ...result,
            phase: events[ticketOf(b)]?.phase ?? null,
            shippingStage: events[ticketOf(b)]?.shippingStage ?? null,
            agent: profile?.agent ?? null,
          };
        }
        case "launch-requests": {
          const [items, handles, events] = await Promise.all([
            store.openInboxItems({ project: slug, recipient: "coordinator" }),
            store.openRuntimeHandles(slug),
            store.latestEvents(slug),
          ]);
          const flight = deps.snapshot?.flight;
          const model = flight
            ? buildModel(attachPullRequests(flight.program, flight.forge), flight.program.rootId)
            : null;
          const held = model && flight ? deferredHeld(model, flight, at, handles, events) : null;
          return items
            .filter((i) => i.kind === "launch-request" && i.request?.deferred)
            .filter((i) => b.coordinatorName === undefined || !i.coordinator || i.coordinator === coordinatorName)
            .map((i) =>
              deferredLaunchState(
                i,
                model,
                deps.config?.tracker.parkedLabel,
                !!i.ticket && !!held?.has(i.ticket),
                caller.kind === "organization" ? (caller.launchAuthor ?? caller.author) : null,
                !!i.request?.profile && deps.config?.conductor.profiles[i.request.profile]?.runtime === "claude-code",
              ),
            );
        }
        case "launches":
          return followedLaunches(await store.pendingLaunches(slug, new Date(at.getTime() - LAUNCH_WINDOW_MS)), at);
        case "inbox": {
          const silent = b.silentAfterMinutes;
          if (typeof silent !== "number" || !Number.isFinite(silent) || silent < 0)
            throw new Invalid("silentAfterMinutes must be a number of minutes");
          const notStarted = b.notStartedMinutes;
          if (
            notStarted !== undefined &&
            (typeof notStarted !== "number" || !Number.isFinite(notStarted) || notStarted < 0)
          )
            throw new Invalid("notStartedMinutes must be a number of minutes");
          const read = await serveInbox(
            store,
            slug,
            {
              coordinator: optText(b, "coordinator", LINE_MAX),
              ...(b.coordinatorName === undefined ? {} : { coordinatorName: coordinatorName ?? "default" }),
              ...(b.facts == null ? {} : { facts: coordinatorFacts(objectOf(b.facts)) }),
              silentAfterMinutes: silent,
              quietAfterMinutes: positiveMinutes(b, "quietAfterMinutes"),
              ...(notStarted !== undefined ? { notStartedMinutes: notStarted } : {}),
              etag: optText(b, "etag", 64),
            },
            at,
            deps.cliVersion && CLI_VERSION.test(deps.cliVersion) ? deps.cliVersion : null,
            deps.snapshot,
          );
          return read ?? NOT_MODIFIED;
        }
        case "inbox/item":
          return store.getInboxItem(slug, idOf(b, "id"));
        case "inbox/ticket":
          return store.openInboxItems({ project: slug, recipient: "coordinator", ticket: ticketOf(b) });
        case "inbox/resolve": {
          const id = idOf(b, "id");
          if ((await store.getInboxItem(slug, id))?.kind === "hold")
            throw new Invalid('a merge hold is resolved with armada hold clear <id> --reason "<why>"');
          return store.resolveInboxItem({
            project: slug,
            id: idOf(b, "id"),
            resolution: text(b, "resolution", BODY_MAX),
            at,
          });
        }
        case "answer": {
          const item = b.item === null || b.item === undefined ? null : idOf(b, "item");
          if (item !== null && (await store.getInboxItem(slug, item))?.kind === "hold")
            throw new Invalid('a merge hold is resolved with armada hold clear <id> --reason "<why>"');
          return recordAnswer(
            store,
            slug,
            {
              coordinator: coordinatorName,
              text: text(b, "text", BODY_MAX),
              note: bool(b, "note"),
              ticket: b.ticket === null || b.ticket === undefined ? null : ticketOf(b),
              item,
            },
            at,
          );
        }
        case "merge": {
          const number = b.number;
          if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
            throw new Invalid("number must be a pull request number");
          const headSha = shaOf(b, "headSha");
          if (!headSha) throw new Invalid("headSha is required");
          return recordMerge(
            store,
            slug,
            {
              ticket: ticketOf(b),
              number,
              url: text(b, "url", URL_MAX),
              mergeCommit: shaOf(b, "mergeCommit"),
              headSha,
              decision: optText(b, "decision", BODY_MAX),
            },
            at,
          );
        }
        case "validate": {
          const input = validationOf(b);
          if (caller.kind === "worker" && input.kind !== "validation")
            throw new Invalid("a worker session only asks the owner to validate its work (kind validation)");
          const validation = await recordValidation(
            store,
            slug,
            {
              ...input,
              // A worker shows its own work: the pull request card and the reason are the coordinator's to give.
              ...(caller.kind === "worker" ? { pr: null, reason: null } : {}),
              worker: caller.kind === "worker",
              author: caller.kind === "organization" ? (caller.author ?? "coordinator") : null,
            },
            at,
          );
          return { validation, url: approvalUrl(deps.appUrl ?? null, validation.id) };
        }
        case "validations":
          return store.listValidations({
            project: slug,
            ...(b.ticket == null ? {} : { ticket: ticketOf(b) }),
            ...(b.pr == null ? {} : { pr: idOf(b, "pr") }),
          });
        case "done":
          return recordDone(store, slug, { ticket: ticketOf(b), message: text(b, "message", BODY_MAX) }, at);
        case "queue/add": {
          const noTicket = bool(b, "noTicket");
          const ticket = b.ticket == null ? null : ticketOf(b);
          if (noTicket !== (ticket === null)) throw new Invalid("ticket and noTicket disagree");
          const headSha = shaOf(b, "headSha");
          if (!headSha || !/^[0-9a-f]{40}$/.test(headSha)) throw new Invalid("headSha must be a full 40-character SHA");
          const pr = idOf(b, "pr");
          if (pr > 2147483647) throw new Invalid("pr is too large");
          return store.queueAdd({
            project: slug,
            at,
            pr,
            ticket,
            noTicket,
            keepOpen: bool(b, "keepOpen"),
            throughHold: optText(b, "throughHold", BODY_MAX),
            reason: optText(b, "reason", BODY_MAX),
            headSha,
            queuedBy: caller.kind === "organization" ? (caller.author ?? text(b, "queuedBy", LINE_MAX)) : "coordinator",
          });
        }
        case "queue/list":
          return store.queueList(slug, {
            since: b.since == null ? new Date(at.getTime() - 86400_000) : new Date(dateOf(b, "since")),
          });
        case "queue/next":
          return store.queueNext({ project: slug, holder: text(b, "holder", LINE_MAX), at });
        case "queue/finish": {
          const outcome = b.outcome;
          if (outcome !== "merged" && outcome !== "refused" && outcome !== "retry")
            throw new Invalid("outcome must be merged, refused or retry");
          const mergeCommit = shaOf(b, "mergeCommit");
          if (mergeCommit && !/^[0-9a-f]{40}$/.test(mergeCommit)) throw new Invalid("mergeCommit must be a full SHA");
          const notBefore = b.notBefore == null ? null : dateOf(b, "notBefore");
          if (outcome !== "retry" && notBefore !== null) throw new Invalid("notBefore applies to retry");
          return store.queueFinish({
            project: slug,
            at,
            id: idOf(b, "id"),
            holder: text(b, "holder", LINE_MAX),
            outcome,
            detail: optText(b, "detail", BODY_MAX),
            mergeCommit,
            notBefore,
          });
        }
        case "queue/remove": {
          const pr = idOf(b, "pr");
          if (pr > 2147483647) throw new Invalid("pr is too large");
          return store.queueRemove({ project: slug, pr, at });
        }
        case "lease/acquire":
        case "lease/renew": {
          const ttl = b.ttlMs;
          if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl < 1000 || ttl > LEASE_TTL_MAX_MS)
            throw new Invalid(`ttlMs must be between 1 s and ${LEASE_TTL_MAX_MS / 60_000} min`);
          const lease = {
            project: slug,
            name: text(b, "name", 64),
            holder: text(b, "holder", LINE_MAX),
            ttlMs: ttl,
            at,
          };
          const throughHold = optText(b, "throughHold", BODY_MAX);
          if (throughHold !== null && !throughHold.trim()) throw new Invalid("throughHold needs a reason");
          // Older supported CLIs do not read holds. The server stops their lease too,
          // without cutting off unrelated worker commands via a global version bump.
          if (lease.name === MERGE_LEASE && !throughHold) {
            const holds = await store.openHolds(slug);
            if (holds.length) throw new Held(`${holdsPaused(holds, at)}. ${holdsNext(holds)}`, holdsNext(holds));
          }
          return op === "lease/acquire" ? store.acquireLease(lease) : store.renewLease(lease);
        }
        case "lease/release":
          return store.releaseLease({ project: slug, name: text(b, "name", 64), holder: text(b, "holder", LINE_MAX) });
      }
    })();
    if (result === TRANSFER_REFUSED)
      return refuse(
        409,
        "tickets were not transferred: a ticket is missing or its owner changed",
        "armada coordinator list, then retry with the current --from",
      );
    if (result === NOT_MODIFIED) return { status: 304, body: {} };
    return { status: 200, body: { result: result ?? null } };
  } catch (err) {
    if (err instanceof JobScopeError) return refuse(403, "job is not on this ticket and project", "armada job list");
    if (err instanceof Held) return refuse(409, err.message, err.next);
    if (err instanceof RequestRefusal) return refuse(400, err.message, "armada inbox");
    if (err instanceof Invalid)
      return refuse(400, `fleet ${op}: ${err.message}`, "update the CLI: npm install -g @the-vibe-company/armada");
    throw err;
  }
}

const CI_STATES: readonly CiState[] = ["success", "failure", "pending", "none"];

function httpsOrNull(b: Body, key: string): string | null {
  const v = optText(b, key, URL_MAX);
  if (v === null) return null;
  try {
    if (new URL(v).protocol === "https:") return v;
  } catch {}
  throw new Invalid(`${key} must be an HTTPS URL`);
}

function countOrNull(b: Body, key: string): number | null {
  const v = b[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Invalid(`${key} must be a count`);
  return v;
}

function validationPrOf(v: unknown): ValidationPr | null {
  if (v === null || v === undefined) return null;
  const p = objectOf(v);
  const headSha = shaOf(p, "headSha");
  if (!headSha) throw new Invalid("pr.headSha is required");
  const files = p.files;
  if (files !== null && files !== undefined && (!Array.isArray(files) || files.length > 300))
    throw new Invalid("pr.files must be a list of at most 300 files");
  const ci = p.ci ?? null;
  if (ci !== null && !CI_STATES.includes(ci as CiState)) throw new Invalid("pr.ci must be a CI state");
  return {
    number: idOf(p, "number"),
    url:
      httpsOrNull(p, "url") ??
      (() => {
        throw new Invalid("pr.url is required");
      })(),
    title: text(p, "title", LINE_MAX),
    headSha,
    files: Array.isArray(files)
      ? files.map((f) => {
          const file = objectOf(f);
          return {
            path: text(file, "path", LINE_MAX),
            additions: countOrNull(file, "additions") ?? 0,
            deletions: countOrNull(file, "deletions") ?? 0,
          };
        })
      : null,
    additions: countOrNull(p, "additions"),
    deletions: countOrNull(p, "deletions"),
    ci: ci as CiState | null,
    preview: httpsOrNull(p, "preview"),
  };
}

function validationOf(b: Body): ValidationRecord {
  const kind = b.kind;
  if (!VALIDATION_KINDS.includes(kind as ValidationKind))
    throw new Invalid("kind must be merge, validation or question");
  const L = VALIDATION_LIMITS;
  const choices = b.choices;
  if (
    choices !== null &&
    choices !== undefined &&
    (!Array.isArray(choices) ||
      choices.length < 1 ||
      choices.length > L.choices ||
      !choices.every((c) => typeof c === "string" && c.trim() && c.length <= L.choice))
  )
    throw new Invalid(`choices must be 1 to ${L.choices} choices of at most ${L.choice} characters`);
  const attachments = b.attachments ?? [];
  if (
    !Array.isArray(attachments) ||
    attachments.length > L.attachments ||
    !attachments.every((a) => typeof a === "string" && /^[\w-]{1,64}$/.test(a))
  )
    throw new Invalid(`attachments must be at most ${L.attachments} attachment ids`);
  const pr = validationPrOf(b.pr);
  if (kind === "merge" && !pr) throw new Invalid("a merge approval names its pull request");
  return {
    ticket: ticketOf(b),
    kind: kind as ValidationKind,
    what: text(b, "what", L.what),
    reason: optText(b, "reason", L.reason),
    choices: Array.isArray(choices) ? choices.map((c: string) => c.trim()) : null,
    pr,
    attachments: attachments as string[],
  };
}

// ------------------------------------------------------------------ the CLI's half

/** How long one call to the fleet may take. */
const CALL_TIMEOUT_MS = 15_000;

/**
 * The fleet of `project` through the Armada API, signed in as `signIn`. Every
 * refusal or failure is an `ArmadaApiError`; worker commands turn it into a
 * warning, since Linear is the record.
 */
export function fleetClient(o: {
  api: Pick<ArmadaApi, "fleet">;
  signIn: ArmadaSignIn;
  project: ProjectInput;
  coordinatorName?: string | (() => Promise<string>);
}): Fleet {
  const call = async <T>(op: FleetOp, input: object): Promise<T> => {
    const coordinatorName = typeof o.coordinatorName === "function" ? await o.coordinatorName() : o.coordinatorName;
    return (await o.api.fleet(
      o.signIn,
      op,
      {
        project: o.project,
        input: { ...input, ...(coordinatorName === undefined ? {} : { coordinatorName }) },
      },
      CALL_TIMEOUT_MS,
    )) as T;
  };
  return {
    coordinators: () => call<CoordinatorRecord[]>("coordinators", {}),
    takeTickets: (input) => call<boolean>("coordinators/take", input),
    startJob: (input) => call<Job>("job/start", input),
    listJobs: (query) => call<Job[]>("job/list", query),
    observeJob: (input) => call<Job | null>("job/observe", input),
    digest: (input) => call("digest", input),
    sendDigest: (input) => call("digest/send", input),
    reserve: (input) => call("reserve", input),
    reservations: (ticket) => call<Reservation[]>("reservations", ticket ? { ticket } : {}),
    unreserve: (input) => call("unreserve", input),
    coordinator: (facts) => call<null>("coordinator", facts).then(() => undefined),
    request: (input) => call<number>("request", input),
    deferLaunch: (input) => call<DeferredLaunch>("request", { ...input, kind: "launch-when-unblocked" }),
    deferredLaunches: () => call<DeferredLaunch[]>("launch-requests", {}),
    holds: () => call("holds", {}),
    openHold: (input) => call("hold/open", input),
    clearHold: (input) => call("hold/clear", input),
    register: () => call<null>("register", {}).then(() => undefined),
    eventsSince: (q) => call<EventsRead | null>("events/since", q),
    latestEvents: () => call<Record<string, LatestEvent>>("events/state", {}),
    lastEventTimes: () => call<Record<string, string>>("events/latest", {}),
    heartbeatTimes: () => call<Record<string, string>>("heartbeats/latest", {}),
    heartbeat: (input) => call("heartbeat", input),
    runtimeHandles: () => call("runtime/handles", {}),
    runtimeHandle: (ticket) => call("runtime/handle", { ticket }),
    runtimeReference: (ref) => call("runtime/reference", ref),
    observeRuntime: (input) => call("runtime/observe", input),
    stopRuntime: (input) => call("runtime/stop", input),
    pendingLaunches: () => call<PendingLaunch[]>("launches", {}),
    claim: (c: ClaimRecord) => call<InboxItem[]>("claim", c),
    report: async (r: ReportRecord) => {
      const result = await call<InboxItem[] | ReportResult>("report", r);
      return Array.isArray(result) ? { inbox: result, overlaps: [], incomplete: r.paths !== undefined } : result;
    },
    overlap: (input) => call<OverlapReading>("overlap", input),
    ask: (q) => call<number>("ask", q),
    // An older server returned null after releasing successfully.
    release: (r) => call<{ released: boolean } | null>("release", r).then((result) => result ?? { released: true }),
    // Null: not modified (304).
    inbox: (q: InboxQuery) => call<InboxRead | null>("inbox", q),
    inboxItem: (id) => call<StoredInboxItem | null>("inbox/item", { id }),
    ticketItems: (ticket) => call<InboxItem[]>("inbox/ticket", { ticket }),
    answer: (a: AnswerRecord) => call<string>("answer", a),
    resolve: (r) => call<boolean>("inbox/resolve", r),
    merge: (m: MergeRecord) => call<MergeRecorded>("merge", m),
    validate: (v) => call<{ validation: Validation; url: string }>("validate", v),
    validations: (q) => call<Validation[]>("validations", q),
    done: (d) => call<MergeRecorded>("done", d),
    queueAdd: (e) => call<QueueAdded>("queue/add", e),
    queueList: (q = {}) => call<QueueEntry[]>("queue/list", q),
    queueNext: (q) => call<QueueNext>("queue/next", q),
    queueFinish: (q) => call<boolean>("queue/finish", q),
    queueRemove: (q) => call<boolean>("queue/remove", q),
    acquireLease: (l) => call<LeaseResult>("lease/acquire", l),
    renewLease: (l) => call<boolean>("lease/renew", l),
    releaseLease: (l) => call<null>("lease/release", l).then(() => undefined),
  };
}

function coordinatorFacts(input: Record<string, unknown>): CoordinatorFacts {
  if (!["conductor-cloud", "claude-code", "codex", "terminal"].includes(String(input.harness)))
    throw new Invalid("unknown coordinator harness");
  return {
    harness: input.harness as CoordinatorFacts["harness"],
    handle: optText(input, "handle", LINE_MAX),
    model: optText(input, "model", LINE_MAX),
    cliVersion: optText(input, "cliVersion", 80),
  };
}

function positiveMinutes(input: Body, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Invalid(`${key} must be a positive number of minutes`);
  return value;
}
