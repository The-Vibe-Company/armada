// The fleet's live data through the Armada API (THE-850): both halves of
// `POST /api/cli/fleet/<operation>`. The CLI's half (`fleetClient`) sends each
// command's record, for one project, with the terminal's sign-in; the app's
// half (`serveFleet`) checks it and runs it on the fleet's database, with the
// server's clock. A worker session only claims, reports, asks and releases its
// own ticket. Every request names the whole project (slug, name, repository,
// root): the app registers it on first contact, for the caller's organization.
// No error quotes a token.
import type { ArmadaApi, ArmadaSignIn } from "./armada-api.ts";
import {
  type AnswerRecord,
  type ClaimRecord,
  type Fleet,
  type FleetStore,
  type InboxItem,
  type InboxQuery,
  type InboxRead,
  LAUNCH_WINDOW_MS,
  type LeaseResult,
  type MergeRecord,
  type MergeRecorded,
  type PendingLaunch,
  type ProjectInput,
  type ReportRecord,
  recordAnswer,
  recordClaim,
  recordMerge,
  recordQuestion,
  recordRelease,
  recordReport,
  type StoredInboxItem,
  serveInbox,
  type WorkerProfile,
} from "./live.ts";
import { isLabelPhase } from "./phases.ts";
import type { LabelPhase } from "./types.ts";

/** The operations a worker session may run, on its own ticket only. */
export const WORKER_FLEET_OPS = ["claim", "report", "ask", "release"] as const;

/** Every operation, as the path after `/api/cli/fleet/`. */
export const FLEET_OPS = [
  ...WORKER_FLEET_OPS,
  "register",
  "events/latest",
  "launches",
  "inbox",
  "inbox/item",
  "inbox/ticket",
  "inbox/resolve",
  "answer",
  "merge",
  "lease/acquire",
  "lease/renew",
  "lease/release",
] as const;
export type FleetOp = (typeof FLEET_OPS)[number];

/** A lease lasts at most this long: a crashed coordinator never holds the merge lock for good. */
export const LEASE_TTL_MAX_MS = 60 * 60_000;

/** Who calls: a terminal of the project's organization, or a worker session bound to one ticket. */
export type FleetCaller = { kind: "organization" } | { kind: "worker"; ticket: string };

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
  now: () => Date;
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
  deps: ServeFleetDeps,
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
          `a worker session only claims, reports, asks and releases its own ticket (${caller.ticket}), not ${ticket ? `${ticket}` : `\`${op}\``}`,
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
        case "release":
          return recordRelease(store, slug, { ticket: ticketOf(b), reason: text(b, "reason", BODY_MAX) }, at);
        case "register":
          return store.upsertProject(project, at);
        case "events/latest":
          return store.lastEventTimes(slug);
        case "launches":
          return store.pendingLaunches(slug, new Date(at.getTime() - LAUNCH_WINDOW_MS));
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
              silentAfterMinutes: silent,
              ...(notStarted !== undefined ? { notStartedMinutes: notStarted } : {}),
              etag: optText(b, "etag", 64),
            },
            at,
            deps.cliVersion && CLI_VERSION.test(deps.cliVersion) ? deps.cliVersion : null,
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
            },
            at,
          );
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
          return op === "lease/acquire" ? store.acquireLease(lease) : store.renewLease(lease);
        }
        case "lease/release":
          return store.releaseLease({ project: slug, name: text(b, "name", 64), holder: text(b, "holder", LINE_MAX) });
      }
    })();
    if (result === NOT_MODIFIED) return { status: 304, body: {} };
    return { status: 200, body: { result: result ?? null } };
  } catch (err) {
    if (err instanceof Invalid)
      return refuse(400, `fleet ${op}: ${err.message}`, "update the CLI: npm install -g @the-vibe-company/armada");
    throw err;
  }
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
    register: () => call<null>("register", {}).then(() => undefined),
    lastEventTimes: () => call<Record<string, string>>("events/latest", {}),
    pendingLaunches: () => call<PendingLaunch[]>("launches", {}),
    claim: (c: ClaimRecord) => call<InboxItem[]>("claim", c),
    report: (r: ReportRecord) => call<InboxItem[]>("report", r),
    ask: (q) => call<number>("ask", q),
    release: (r) => call<null>("release", r).then(() => undefined),
    // Null: not modified (304).
    inbox: (q: InboxQuery) => call<InboxRead | null>("inbox", q),
    inboxItem: (id) => call<StoredInboxItem | null>("inbox/item", { id }),
    ticketItems: (ticket) => call<InboxItem[]>("inbox/ticket", { ticket }),
    answer: (a: AnswerRecord) => call<string>("answer", a),
    resolve: (r) => call<boolean>("inbox/resolve", r),
    merge: (m: MergeRecord) => call<MergeRecorded>("merge", m),
    acquireLease: (l) => call<LeaseResult>("lease/acquire", l),
    renewLease: (l) => call<boolean>("lease/renew", l),
    releaseLease: (l) => call<null>("lease/release", l).then(() => undefined),
  };
}
