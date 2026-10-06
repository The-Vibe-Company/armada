// The fleet's live data through the Armada API (THE-850): both halves of
// `POST /api/cli/fleet/<operation>`. The CLI's half (`fleetClient`) sends each
// command's record, for one project, with the terminal's sign-in; the app's
// half (`serveFleet`) checks it and runs it on the fleet's database, with the
// server's clock. A worker session only claims, reports, asks and releases its
// own ticket. Every request names the whole project (slug, name, repository,
// root): the app registers it on first contact, for the caller's organization.
// No error quotes a token.
import type { ArmadaApi, ArmadaSignIn } from "./armada-api.ts";
import type { CoordinatorFacts } from "./live.ts";
import {
  type AnswerRecord,
  type ClaimRecord,
  type Fleet,
  type FleetStore,
  followedLaunches,
  type HandBackSnapshot,
  type InboxItem,
  type InboxQuery,
  type InboxRead,
  LAUNCH_WINDOW_MS,
  type LatestEvent,
  type LeaseResult,
  type MergeRecord,
  type MergeRecorded,
  type PendingLaunch,
  type ProjectInput,
  type ReportRecord,
  RUNTIME_STATES,
  type RuntimeState,
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
import { isLabelPhase } from "./phases.ts";
import { RequestRefusal, requestMerge, requestPlanChanges, requestRelease } from "./requests.ts";
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
export const WORKER_FLEET_OPS = ["claim", "report", "ask", "release", "heartbeat", "validate"] as const;

/** Every operation, as the path after `/api/cli/fleet/`. */
export const FLEET_OPS = [
  ...WORKER_FLEET_OPS,
  "register",
  "coordinator",
  "request",
  "events/latest",
  "events/state",
  "heartbeats/latest",
  "runtime/handles",
  "runtime/handle",
  "runtime/reference",
  "runtime/observe",
  "runtime/stop",
  "launches",
  "inbox",
  "inbox/item",
  "inbox/ticket",
  "inbox/resolve",
  "answer",
  "merge",
  "validations",
  "done",
  "lease/acquire",
  "lease/renew",
  "lease/release",
] as const;
export type FleetOp = (typeof FLEET_OPS)[number];

/** A lease lasts at most this long: a crashed coordinator never holds the merge lock for good. */
export const LEASE_TTL_MAX_MS = 60 * 60_000;

/** Who calls: a terminal of the project's organization, or a worker session bound to one ticket. */
export type FleetCaller =
  | { kind: "organization"; author?: string | null }
  | { kind: "worker"; ticket: string; sessionId?: string };

export interface FleetAnswer {
  status: number;
  body: Record<string, unknown>;
}

const TICKET = /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/;
// The project as armada.toml allows it (`config.ts`), within lengths no real project reaches.
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;
const ROOT = /^[A-Za-z][A-Za-z0-9]{0,63}-\d{1,12}$/;
const REPOSITORY = /^[\w.-]{1,200}\/[\w.-]{1,200}$/;
const SHA = /^[0-9a-f]{7,64}$/;

/** A request the server will not run as sent. */
class Invalid extends Error {}

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

export interface ServeFleetDeps {
  /** Stored project facts, supplied by the host, never by the caller. */
  snapshot?: HandBackSnapshot;
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
      const ticket = isWorkerFleetOp(op) ? ticketOf(b) : null;
      if (ticket !== caller.ticket)
        return refuse(
          403,
          `a worker session only claims, reports, asks, validates and releases its own ticket (${caller.ticket}), not ${ticket ? `${ticket}` : `\`${op}\``}`,
          "the coordinator does it",
        );
    }
    const result = await (async (): Promise<unknown> => {
      switch (op) {
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
            },
            at,
          );
        case "report":
          return recordReport(
            store,
            slug,
            {
              ticket: ticketOf(b),
              phase: phaseOf(b, "phase") as LabelPhase,
              shippingStage: shippingStageOf(b),
              previous: phaseOf(b, "previous", true),
              summary: text(b, "summary", BODY_MAX),
              message: optText(b, "message", BODY_MAX) ?? "",
              prUrl: optText(b, "prUrl", URL_MAX),
              // Checked by the CLI for a hand-back only; any other report keeps what it was given.
              headSha: optText(b, "headSha", LINE_MAX),
            },
            at,
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
        case "register":
          return store.upsertProject(
            { ...project, owner: caller.kind === "organization" ? (caller.author ?? null) : null },
            at,
          );
        case "coordinator":
          return store.recordCoordinatorSeen({ project: slug, facts: coordinatorFacts(b), inboxRead: false, at });
        case "request": {
          const common = {
            project: slug,
            author: caller.kind === "organization" ? (caller.author ?? "coordinator") : "",
            now: at,
          };
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
        case "inbox/resolve":
          return store.resolveInboxItem({
            project: slug,
            id: idOf(b, "id"),
            resolution: text(b, "resolution", BODY_MAX),
            at,
          });
        case "answer":
          return recordAnswer(
            store,
            slug,
            {
              text: text(b, "text", BODY_MAX),
              note: bool(b, "note"),
              ticket: b.ticket === null || b.ticket === undefined ? null : ticketOf(b),
              item: b.item === null || b.item === undefined ? null : idOf(b, "item"),
            },
            at,
          );
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
          return op === "lease/acquire" ? store.acquireLease(lease) : store.renewLease(lease);
        }
        case "lease/release":
          return store.releaseLease({ project: slug, name: text(b, "name", 64), holder: text(b, "holder", LINE_MAX) });
      }
    })();
    if (result === NOT_MODIFIED) return { status: 304, body: {} };
    return { status: 200, body: { result: result ?? null } };
  } catch (err) {
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
export function fleetClient(o: { api: Pick<ArmadaApi, "fleet">; signIn: ArmadaSignIn; project: ProjectInput }): Fleet {
  const call = async <T>(op: FleetOp, input: object): Promise<T> =>
    (await o.api.fleet(o.signIn, op, { project: o.project, input }, CALL_TIMEOUT_MS)) as T;
  return {
    coordinator: (facts) => call<null>("coordinator", facts).then(() => undefined),
    request: (input) => call<number>("request", input),
    register: () => call<null>("register", {}).then(() => undefined),
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
    report: (r: ReportRecord) => call<InboxItem[]>("report", r),
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
