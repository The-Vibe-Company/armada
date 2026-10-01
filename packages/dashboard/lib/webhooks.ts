// The webhooks that keep each project's reading fresh (THE-853): Linear's
// (tickets, comments, attachments, labels) and the Armada GitHub App's (pull
// requests, check suites and runs, commit statuses). Each one is verified
// (Linear: HMAC-SHA256 of the raw body in `Linear-Signature`, and a
// `webhookTimestamp` within a minute; GitHub: `X-Hub-Signature-256` with the
// app's webhook secret), marks the readings it concerns in one statement and
// answers at once; the refresh runs after the answer (`refresh`, Next's
// `after()` in the route). A payload only picks which projects to read again:
// nothing in it is stored or shown, so the reading always comes from Linear
// and GitHub with the project's own keys. Everything is injected.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Database } from "./db";
import { markEveryProject, markIssues, markRepository } from "./snapshots";

export const WEBHOOK_VARIABLES = {
  linear: "ARMADA_LINEAR_WEBHOOK_SECRET",
  github: "ARMADA_GITHUB_WEBHOOK_SECRET",
} as const;

export type Env = Readonly<Record<string, string | undefined>>;

export interface WebhookSecrets {
  linear: string | null;
  github: string | null;
}

export function webhookSecretsOf(env: Env): WebhookSecrets {
  const pick = (name: string) => env[name]?.trim() || null;
  return { linear: pick(WEBHOOK_VARIABLES.linear), github: pick(WEBHOOK_VARIABLES.github) };
}

/** Linear's and GitHub's deliveries are far smaller; anything larger is refused unread. */
export const MAX_BODY_BYTES = 1_000_000;
/** How old a Linear delivery may be: a replayed one is refused. */
export const LINEAR_MAX_AGE_MS = 60_000;

/** The GitHub events that change what the Fleet view shows of a pull request. */
export const GITHUB_EVENTS = ["pull_request", "check_suite", "check_run", "status"] as const;

export interface WebhookDeps {
  secrets: WebhookSecrets;
  /** The app's database; null when none is configured. */
  database: () => Promise<Database | null>;
  /** Refreshes the marked readings after the answer. */
  refresh: (keys: string[]) => void;
  now?: () => Date;
}

const NO_STORE = { "Cache-Control": "no-store" };
const answer = (status: number, body: object) => Response.json(body, { status, headers: NO_STORE });

/** HMAC-SHA256 of `body` in hex, compared in constant time with what the sender gave. */
export function signatureMatches(secret: string, body: string, given: string | null): boolean {
  if (!given || !/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}

async function rawBody(request: Request): Promise<string | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return null;
  const body = await request.text();
  return Buffer.byteLength(body) > MAX_BODY_BYTES ? null : body;
}

function parse(body: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(body) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** The Linear ids a delivery is about, and whether only a whole read can follow it. */
export function linearTargets(payload: Record<string, unknown>): {
  ids: string[];
  full: boolean;
  everyProject: boolean;
} {
  const type = str(payload.type);
  const action = str(payload.action);
  const data = obj(payload.data);
  const from = obj(payload.updatedFrom);
  const ids: (string | null)[] = [];
  switch (type) {
    case "Issue":
      // The ticket, its parent (a new ticket under the program), and its old parent (moved out of it).
      ids.push(str(data.id), str(data.parentId), str(from.parentId));
      break;
    case "Comment":
    case "Attachment":
      ids.push(str(data.issueId), str(obj(data.issue).id));
      break;
    case "IssueRelation":
      ids.push(str(data.issueId), str(data.relatedIssueId));
      break;
    case "IssueLabel":
      // A label renamed or deleted changes tickets without updating them.
      return { ids: [], full: true, everyProject: true };
  }
  return {
    ids: [...new Set(ids.filter((id): id is string => id !== null))],
    full: type === "Issue" && action === "remove",
    everyProject: false,
  };
}

/** POST /api/webhooks/linear */
export async function handleLinearWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  const secret = deps.secrets.linear;
  if (!secret) return answer(503, { error: `${WEBHOOK_VARIABLES.linear} is not set on this dashboard` });
  const body = await rawBody(request);
  if (body === null) return answer(413, { error: "payload too large" });
  if (!signatureMatches(secret, body, request.headers.get("linear-signature")))
    return answer(401, { error: "invalid signature" });
  const payload = parse(body);
  if (!payload) return answer(400, { error: "not JSON" });
  const sent = Number(payload.webhookTimestamp);
  const now = (deps.now?.() ?? new Date()).getTime();
  if (!Number.isFinite(sent) || Math.abs(now - sent) > LINEAR_MAX_AGE_MS)
    return answer(401, { error: "stale delivery" });

  const db = await deps.database();
  if (!db) return answer(503, { error: "the app's database is not configured" });
  const { ids, full, everyProject } = linearTargets(payload);
  if (everyProject) {
    // Every reading is read whole on its next view; nothing is read now.
    await markEveryProject(db);
    return answer(202, { marked: "every project" });
  }
  const keys = await markIssues(db, ids, { full, now: new Date(now) });
  if (keys.length) deps.refresh(keys);
  return answer(202, { marked: keys.length });
}

/** POST /api/webhooks/github: the Armada GitHub App's webhook. */
export async function handleGithubWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  const secret = deps.secrets.github;
  if (!secret) return answer(503, { error: `${WEBHOOK_VARIABLES.github} is not set on this dashboard` });
  const body = await rawBody(request);
  if (body === null) return answer(413, { error: "payload too large" });
  const header = request.headers.get("x-hub-signature-256") ?? "";
  if (!signatureMatches(secret, body, /^sha256=(.+)$/.exec(header)?.[1] ?? null))
    return answer(401, { error: "invalid signature" });
  const event = request.headers.get("x-github-event") ?? "";
  if (!(GITHUB_EVENTS as readonly string[]).includes(event)) return answer(202, { ignored: event || "no event" });
  const payload = parse(body);
  if (!payload) return answer(400, { error: "not JSON" });
  const repository = str(obj(payload.repository).full_name);
  if (!repository) return answer(202, { ignored: "no repository" });

  const db = await deps.database();
  if (!db) return answer(503, { error: "the app's database is not configured" });
  const keys = await markRepository(db, repository, deps.now?.() ?? new Date());
  if (keys.length) deps.refresh(keys);
  return answer(202, { marked: keys.length });
}
