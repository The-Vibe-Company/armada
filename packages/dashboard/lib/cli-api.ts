// The Armada API the CLI calls, under /api/cli: signing in from a terminal
// (Better Auth's device authorization), who is signed in, signing out, the
// organization's Linear key from the vault (`POST credentials`, THE-840), the
// workers' launch tokens (THE-841: `launch-tokens`, `launch-tokens/exchange`,
// `workers/end`), and the fleet's live data (THE-850: `fleet/<operation>`,
// run by core's `serveFleet` on `fleet-store.ts`; `projects`). No terminal
// ever holds a database key. A terminal holds a session token from `armada login` (sent
// as `Authorization: Bearer`), an organization API key (`x-api-key`), or a
// worker session from `armada login --launch-token` (a bearer token too, told
// apart by its prefix); it never holds the browser's cookie. A worker session
// only claims, reports, asks and releases its own ticket. Both proxy gates let /api/cli through: each
// route checks its own credential, and while the deployment has no accounts
// every route refuses with the next step instead of a password prompt.
// Every answer names the oldest CLI that reads it right and the latest one, so
// an outdated CLI tells its person to upgrade. Everything is injected so tests
// run it on PGlite.
import {
  CLI_LATEST_HEADER,
  CLI_MINIMUM_HEADER,
  CLI_VERSION_HEADER,
  compareVersions,
  type FleetCaller,
  installCommand,
  MINIMUM_CLI_VERSION,
  parseProject,
  serveFleet,
  upgradeLine,
  versionToInstall,
} from "@armada/core/read";
import cliPackage from "../../cli/package.json" with { type: "json" };
import { type Auth, firstOrganization, organizationOf } from "./accounts";
import { AUTH_API_PREFIX, type AuthSettings, CLI_CLIENT_ID } from "./accounts-settings";
import { type Holder, releaseCredentials } from "./broker";
import type { Database, Queryable } from "./db";
import { fleetStore, holdProject, projectsOf } from "./fleet-store";
import { SECRETS_KEY_VARIABLE, type VaultKey, type VaultMode } from "./vault";
import {
  createLaunch,
  endTicketWorkers,
  endWorker,
  exchangeLaunch,
  isProjectSlug,
  isTicketId,
  isWorkerCommand,
  isWorkerToken,
  launchingUser,
  WORKER_COMMANDS,
  type Worker,
  workerActor,
  workerSession,
} from "./workers";

/** The CLI released from this commit, what an outdated CLI is told to install; never below the minimum. */
const LATEST_CLI_VERSION = versionToInstall(MINIMUM_CLI_VERSION, cliPackage.version);

export interface CliAccounts {
  auth: Auth;
  client: Database;
  settings: AuthSettings;
}

export interface CliApiDeps {
  /** The deployment's accounts; null while it runs on the shared password. Throws when they cannot be opened. */
  accounts: () => Promise<CliAccounts | null>;
  /** The vault's master key; off, `POST credentials` answers 503 and the CLI keeps its local keys. */
  vault?: () => VaultMode;
  now?: () => Date;
}

/** Who a terminal is signed in as. Carries no secret. */
export interface CliIdentity {
  schemaVersion: 1;
  via: "session" | "api-key" | "worker";
  /** The person, for a session; null for an API key, which acts for its organization, and for a worker. */
  user: { id: string; name: string; email: string } | null;
  /** The organization the terminal acts for; null when a person belongs to none yet. */
  organization: { id: string; name: string; slug: string; role: string | null } | null;
  /** The key's name and first characters, for an API key. */
  apiKey: { id: string; name: string | null; start: string | null } | null;
  /** The ticket a worker session acts on, and who launched it. */
  worker: { id: string; project: string; ticket: string; launchedBy: string } | null;
  expiresAt: string | null;
}

// Keys pass through these answers: no cache, anywhere, may keep one.
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };
const LOGIN = "armada login";

const refuse = (status: number, error: string, next: string) =>
  Response.json({ error, next }, { status, headers: NO_STORE });

const signedOut = (error: string) => refuse(401, error, LOGIN);

/** What a worker without a valid launch does next. */
const NEW_LAUNCH = "ask the coordinator for a new launch: `armada brief <ticket>` makes a new launch token";
const WORKER_SCOPE = `a worker session only ${WORKER_COMMANDS.slice(0, -1).join(", ")} and ${WORKER_COMMANDS.at(-1)} on its own ticket`;
const hhmm = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** Session lifetime and refresh age, as `createAuth` sets them. */
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_SECONDS = 24 * 60 * 60;

type Credential =
  | { kind: "session"; token: string }
  | { kind: "api-key"; key: string }
  | { kind: "worker"; token: string }
  | null;

function credentialOf(request: Request): Credential {
  const key = request.headers.get("x-api-key")?.trim();
  if (key) return { kind: "api-key", key };
  const header = request.headers.get("authorization") ?? "";
  const token = /^bearer\s+(\S+)\s*$/i.exec(header)?.[1];
  if (!token) return null;
  return isWorkerToken(token) ? { kind: "worker", token } : { kind: "session", token };
}

const dateOf = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(typeof v === "number" ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The session behind a CLI token, refreshed like a browser's: past a day of
 * use it lasts another 30 days. Null when unknown or expired.
 */
async function sessionOf(a: CliAccounts, token: string, now: Date) {
  const ctx = await a.auth.$context;
  const found = await ctx.internalAdapter.findSession(token);
  const expiresAt = dateOf(found?.session.expiresAt);
  if (!found || !expiresAt || expiresAt <= now) return null;
  let expires = expiresAt;
  if (expiresAt.getTime() - (SESSION_SECONDS - REFRESH_SECONDS) * 1000 <= now.getTime()) {
    expires = new Date(now.getTime() + SESSION_SECONDS * 1000);
    await ctx.internalAdapter.updateSession(token, { expiresAt: expires, updatedAt: now });
  }
  return { ...found, expiresAt: expires };
}

async function organizationById(client: Queryable, id: string) {
  const rs = await client.query(`SELECT "id", "name", "slug" FROM "organization" WHERE "id" = $1`, [id]);
  const row = rs.rows[0];
  return row ? { id: String(row.id), name: String(row.name), slug: String(row.slug), role: null } : null;
}

/** Why a worker session is refused, in words the worker can act on. */
function workerRefusal(worker: Worker | null): Response {
  if (!worker) return refuse(401, "this worker session is not valid: it never existed, or was replaced", NEW_LAUNCH);
  if (worker.endReason === "revoked")
    return refuse(
      401,
      `this worker was cut off from Armada by ${worker.endedBy ?? "an organization admin"} at ${hhmm(worker.endedAt ?? "")}: stop working on ${worker.ticket}`,
      "report the cut-off to the coordinator in your reply, and do nothing more on the ticket",
    );
  if (worker.endReason)
    return refuse(
      401,
      `the worker session of ${worker.ticket} ended at ${hhmm(worker.endedAt ?? "")}: the ticket was ${worker.endReason}`,
      NEW_LAUNCH,
    );
  return refuse(
    401,
    `the worker session of ${worker.ticket} expired at ${hhmm(worker.sessionExpiresAt ?? "")}, after too long without a command`,
    NEW_LAUNCH,
  );
}

async function identify(
  a: CliAccounts,
  credential: Credential,
  now: Date,
): Promise<(CliIdentity & { launch?: Worker }) | Response> {
  if (!credential) return signedOut("not signed in to Armada");
  if (credential.kind === "worker") {
    const found = await workerSession(a.client, credential.token, now);
    if (!found.ok) return workerRefusal(found.worker);
    const w = found.worker;
    const organization = await organizationById(a.client, w.organization);
    if (!organization) return workerRefusal(null);
    return {
      schemaVersion: 1,
      via: "worker",
      user: null,
      organization,
      apiKey: null,
      worker: { id: w.id, project: w.project, ticket: w.ticket, launchedBy: w.launchedBy.label },
      expiresAt: w.sessionExpiresAt,
      launch: w,
    };
  }
  if (credential.kind === "api-key") {
    const result = await a.auth.api.verifyApiKey({ body: { key: credential.key } });
    const key = result.valid ? result.key : null;
    const organization = key ? await organizationById(a.client, key.referenceId) : null;
    if (!key || !organization) return signedOut("this Armada API key is not valid: it was revoked, or never existed");
    return {
      schemaVersion: 1,
      via: "api-key",
      user: null,
      organization,
      apiKey: { id: key.id, name: key.name ?? null, start: key.start ?? null },
      worker: null,
      expiresAt: dateOf(key.expiresAt)?.toISOString() ?? null,
    };
  }
  const found = await sessionOf(a, credential.token, now);
  if (!found) return signedOut("the Armada sign-in of this terminal has expired or was revoked");
  const active = (found.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;
  return {
    schemaVersion: 1,
    via: "session",
    user: { id: found.user.id, name: found.user.name, email: found.user.email },
    organization: await organizationOf(a.client, found.user.id, active),
    apiKey: null,
    worker: null,
    expiresAt: found.expiresAt.toISOString(),
  };
}

/** Who receives the keys, as the audit list names them. A worker gets the keys of whoever launched it. */
function holderOf(identity: CliIdentity & { launch?: Worker }): Holder | null {
  const organization = identity.organization;
  if (!organization) return null;
  const org = { id: organization.id, name: organization.name, slug: organization.slug };
  if (identity.via === "worker") {
    const w = identity.launch;
    return w ? { actor: workerActor(w), organization: org, user: launchingUser(w), ticket: w.ticket } : null;
  }
  if (identity.via === "api-key") {
    const key = identity.apiKey;
    return {
      actor: { kind: "api-key", id: key?.id ?? "", label: `API key "${key?.name ?? key?.start ?? "?"}"` },
      organization: org,
      user: null,
    };
  }
  const user = identity.user;
  if (!user) return null;
  const label = user.name && user.name !== user.email ? `${user.name} <${user.email}>` : user.email;
  return { actor: { kind: "session", id: user.id, label }, organization: org, user: user.id };
}

async function credentials(a: CliAccounts, request: Request, deps: CliApiDeps, now: Date): Promise<Response> {
  const vault = vaultKeyOf(deps, "it hands out no key");
  if (vault instanceof Response) return vault;
  const identity = await identify(a, credentialOf(request), now);
  if (identity instanceof Response) return identity;
  const body = await jsonBody(request);
  // A CLI from before 0.2.0 sends no version but still asks for the retired fleet database's
  // token, and reads no version header: its refusal names the upgrade itself.
  if (!request.headers.get(CLI_VERSION_HEADER) && "turso" in body)
    return refuse(
      426,
      `this CLI is older than this server expects (${MINIMUM_CLI_VERSION} or newer)`,
      installCommand(LATEST_CLI_VERSION),
    );
  const holder = holderOf(identity);
  if (!holder) return noOrganization(a);
  const purpose = purposeOf(body);
  if (identity.via === "worker") {
    const scope = workerScope(identity.launch, purpose);
    if (scope) {
      console.warn(`armada dashboard: keys refused to ${holder.actor.label} (${holder.organization.slug}): ${scope}`);
      return refuse(403, scope, "the coordinator does it");
    }
  } else if (purpose.ticket) holder.ticket = purpose.ticket;
  const answer = await releaseCredentials({ client: a.client, vault, now: () => now }, holder);
  if (!answer.ok) return refuse(429, "too many requests for keys in a minute", "the same command again in a minute");
  const r = answer.release;
  // Names what went out, never a value.
  console.info(
    `armada dashboard: keys released to ${holder.actor.label} (${holder.organization.slug}): linear ${r.linear?.scope ?? "none"}`,
  );
  return Response.json(r, { headers: NO_STORE });
}

const noOrganization = (a: CliAccounts) =>
  refuse(
    403,
    "this account is in no organization yet, so no key is handed out",
    `accept an invitation, or create an organization, at ${new URL("/welcome", a.settings.baseUrl)}`,
  );

/** What the terminal says it needs the keys for: the command, and the project and ticket it acts on. */
function purposeOf(body: Record<string, unknown>): {
  command: string | null;
  project: string | null;
  ticket: string | null;
} {
  const p = body.purpose as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== "object") return { command: null, project: null, ticket: null };
  return {
    command: typeof p.command === "string" ? p.command.slice(0, 32) : null,
    project: isProjectSlug(p.project) ? p.project : null,
    ticket: isTicketId(p.ticket) ? p.ticket.toUpperCase() : null,
  };
}

/** Why a worker session may not have keys for this purpose; null when it may. */
function workerScope(w: Worker | undefined, p: ReturnType<typeof purposeOf>): string | null {
  if (!w) return "this worker session is not valid";
  if (!isWorkerCommand(p.command))
    return `${WORKER_SCOPE}, not ${p.command ? `\`armada ${p.command}\`` : "this command"}`;
  if (p.project !== w.project)
    return `this worker session is for the project ${w.project}, not ${p.project ?? "this one"}`;
  if (p.ticket !== w.ticket) return `this worker session acts on ${w.ticket} only, not ${p.ticket ?? "this ticket"}`;
  return null;
}

/** The vault's key, or why this Armada cannot hand keys out: `what` says what that means for the caller. */
function vaultKeyOf(deps: CliApiDeps, what: string): VaultKey | Response {
  const vault = deps.vault?.() ?? { kind: "off" };
  if (vault.kind === "on") return vault.key;
  if (vault.kind === "invalid") {
    console.error(`armada dashboard: the vault is off: ${vault.reason}`);
    return refuse(
      503,
      `this Armada's vault is misconfigured, so ${what}`,
      "ask its owner to fix ARMADA_SECRETS_KEY; until then, keep the keys in `armada auth login`",
    );
  }
  return refuse(
    503,
    `this Armada keeps no keys (${SECRETS_KEY_VARIABLE} is not set), so ${what}`,
    "keep the keys in `armada auth login`, or ask its owner to set up the vault",
  );
}

/** `armada brief`: a one-time launch token for one ticket, made for a person's terminal or an API key. */
async function launch(a: CliAccounts, request: Request, deps: CliApiDeps, now: Date): Promise<Response> {
  const vault = vaultKeyOf(deps, "a worker it launches would get no key");
  if (vault instanceof Response) return vault;
  const identity = await identify(a, credentialOf(request), now);
  if (identity instanceof Response) return identity;
  if (identity.via === "worker")
    return refuse(403, `${WORKER_SCOPE}: it launches no other worker`, "the coordinator does it");
  const holder = holderOf(identity);
  if (!holder) return noOrganization(a);
  const body = await jsonBody(request);
  if (!isProjectSlug(body.project) || !isTicketId(body.ticket))
    return refuse(
      400,
      "a launch token needs the project slug and the ticket id",
      "armada brief <ticket>, in the project's repository",
    );
  const { worker, token } = await createLaunch(a.client, {
    organization: holder.organization.id,
    project: body.project,
    ticket: body.ticket,
    launcher: { kind: identity.via, id: holder.actor.id, label: holder.actor.label },
    now,
  });
  console.info(
    `armada dashboard: launch token for ${worker.project} ${worker.ticket} made by ${holder.actor.label} (${holder.organization.slug})`,
  );
  return Response.json(
    {
      schemaVersion: 1,
      token,
      expiresAt: worker.tokenExpiresAt,
      worker: { id: worker.id, project: worker.project, ticket: worker.ticket },
      organization: holder.organization,
    },
    { headers: NO_STORE },
  );
}

/** The caller's address, as the platform in front of the app gives it: the exchange's rate limit counts per address. */
function addressOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** `armada login --launch-token`: the token for a worker session. No credential: the token is one. */
async function exchange(a: CliAccounts, request: Request, now: Date): Promise<Response> {
  const token = (await jsonBody(request)).token;
  if (typeof token !== "string" || !token.trim())
    return refuse(400, "no launch token given", "armada login --launch-token <token>, as the launch message says");
  const r = await exchangeLaunch(a.client, { token: token.trim(), address: addressOf(request), now });
  if (!r.ok) {
    const w = r.worker;
    // Names the launch, never the token.
    console.info(
      `armada dashboard: launch token refused (${r.reason})${w ? ` for ${w.project} ${w.ticket}` : ""} from ${addressOf(request)}`,
    );
    switch (r.reason) {
      case "limited":
        return refuse(
          429,
          "too many launch tokens tried from this address in a minute",
          "the same command again in a minute",
        );
      case "unknown":
        return refuse(401, "this launch token is not valid", NEW_LAUNCH);
      case "used":
        return refuse(
          401,
          `this launch token was already used${w?.tokenUsedAt ? ` at ${hhmm(w.tokenUsedAt)}` : ""}: a launch token signs one worker in, once`,
          NEW_LAUNCH,
        );
      case "expired":
        return refuse(
          401,
          `this launch token expired at ${hhmm(w?.tokenExpiresAt ?? "")}: it lasts one hour`,
          NEW_LAUNCH,
        );
      case "ended":
        return refuse(401, `this launch was ${w?.endReason ?? "ended"} before its token was used`, NEW_LAUNCH);
    }
  }
  const w = r.worker;
  const organization = await organizationById(a.client, w.organization);
  if (!organization) return refuse(401, "this launch token is not valid", NEW_LAUNCH);
  console.info(
    `armada dashboard: launch token for ${w.project} ${w.ticket} used from ${addressOf(request)}; worker session ${w.id} started (${organization.slug})`,
  );
  return Response.json(
    {
      schemaVersion: 1,
      token: r.token,
      worker: { id: w.id, project: w.project, ticket: w.ticket, launchedBy: w.launchedBy.label },
      organization: { id: organization.id, name: organization.name, slug: organization.slug },
      expiresAt: w.sessionExpiresAt,
    },
    { headers: NO_STORE },
  );
}

/** The coordinator merged or released a ticket: its worker sessions end. */
async function endWorkers(a: CliAccounts, request: Request, now: Date): Promise<Response> {
  const identity = await identify(a, credentialOf(request), now);
  if (identity instanceof Response) return identity;
  if (identity.via === "worker")
    return refuse(403, `${WORKER_SCOPE}: it ends no other worker`, "armada release, which ends its own session");
  const holder = holderOf(identity);
  if (!holder) return noOrganization(a);
  const body = await jsonBody(request);
  const reason = body.reason === "merged" || body.reason === "released" ? body.reason : null;
  if (!isProjectSlug(body.project) || !isTicketId(body.ticket) || !reason)
    return refuse(
      400,
      "ending a ticket's workers needs the project, the ticket and why (merged or released)",
      "armada merge or armada release",
    );
  const ended = await endTicketWorkers(a.client, {
    organization: holder.organization.id,
    project: body.project,
    ticket: body.ticket,
    reason,
    by: holder.actor,
    now,
  });
  if (ended.length)
    console.info(
      `armada dashboard: ${ended.length} worker session(s) of ${body.project} ${body.ticket.toUpperCase()} ended (${reason}) by ${holder.actor.label}`,
    );
  return Response.json({ ended: ended.length }, { headers: NO_STORE });
}

const UPDATE_CLI = "update the CLI: npm install -g @the-vibe-company/armada";

/**
 * `POST fleet/<operation>`: one operation on the fleet's live data, for the
 * project the request names. The caller's organization holds the project (it
 * is registered for it on first contact); a worker session acts on its own
 * project and ticket only (`serveFleet` checks the ticket).
 */
async function fleet(a: CliAccounts, request: Request, op: string, deps: CliApiDeps): Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const identity = await identify(a, credentialOf(request), now());
  if (identity instanceof Response) return identity;
  const organization = identity.organization;
  if (!organization) return noOrganization(a);
  const body = await jsonBody(request);
  const project = parseProject(body.project);
  if (!project)
    return refuse(400, "a fleet request names its project: slug, name, repository and program root", UPDATE_CLI);
  let caller: FleetCaller = { kind: "organization" };
  if (identity.via === "worker") {
    const w = identity.launch;
    if (!w) return workerRefusal(null);
    if (project.slug !== w.project)
      return refuse(
        403,
        `this worker session is for the project ${w.project}, not ${project.slug}`,
        "the coordinator does it",
      );
    caller = { kind: "worker", ticket: w.ticket };
  }
  const home = async () => (await firstOrganization(a.client))?.id ?? null;
  if (!(await holdProject(a.client, project, organization.id, home, now())))
    return refuse(
      403,
      `the project ${project.slug} belongs to another organization`,
      `another slug in armada.toml ([project] slug), or sign in to the organization of ${project.slug}`,
    );
  const answer = await serveFleet(fleetStore(a.client), { op, project, caller, input: body.input }, { now });
  // An unchanged inbox: nothing to send.
  if (answer.status === 304) return new Response(null, { status: 304, headers: NO_STORE });
  if (answer.status !== 200)
    console.info(
      `armada dashboard: fleet ${op} refused (${answer.status}) for ${project.slug}: ${String(answer.body.error)}`,
    );
  return Response.json(answer.body, { status: answer.status, headers: NO_STORE });
}

/** `GET projects`: the projects of the caller's organization (`armada status --all`). */
async function projects(a: CliAccounts, request: Request, now: Date): Promise<Response> {
  const identity = await identify(a, credentialOf(request), now);
  if (identity instanceof Response) return identity;
  if (identity.via === "worker") return refuse(403, `${WORKER_SCOPE}: it lists no project`, "the coordinator does it");
  const organization = identity.organization;
  if (!organization) return noOrganization(a);
  const own = await projectsOf(a.client, organization.id);
  return Response.json(
    {
      schemaVersion: 1,
      projects: own.map(({ slug, name, repository, programRoot }) => ({ slug, name, repository, programRoot })),
    },
    { headers: NO_STORE },
  );
}

/**
 * Hands a device-authorization call to Better Auth's own route, so its checks
 * and rate limit apply, with the CLI's client id. Cookies never go back: the
 * terminal keeps the token from the body.
 */
async function forward(
  a: CliAccounts,
  request: Request,
  path: string,
  body: Record<string, string>,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["user-agent", "x-forwarded-for", "x-real-ip"]) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  const res = await a.auth.handler(
    new Request(new URL(`${AUTH_API_PREFIX}${path}`, a.settings.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, client_id: CLI_CLIENT_ID }),
    }),
  );
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json", ...NO_STORE },
  });
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Answers one request under /api/cli; `path` is what follows the prefix, e.g.
 * ["session"]. Every answer names the oldest CLI that reads it right and the
 * latest one, which the CLI compares with its own version.
 */
export async function handleCli(request: Request, path: string[], deps: CliApiDeps): Promise<Response> {
  const res = await answerCli(request, path, deps);
  const headers = new Headers(res.headers);
  headers.set(CLI_MINIMUM_HEADER, MINIMUM_CLI_VERSION);
  headers.set(CLI_LATEST_HEADER, LATEST_CLI_VERSION);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function answerCli(request: Request, path: string[], deps: CliApiDeps): Promise<Response> {
  // An outdated CLI is refused before anything runs: no write happens that it could not read back.
  const version = request.headers.get(CLI_VERSION_HEADER);
  if (version && compareVersions(version, MINIMUM_CLI_VERSION) < 0)
    return refuse(426, upgradeLine(version, LATEST_CLI_VERSION), installCommand(LATEST_CLI_VERSION));
  const now = deps.now?.() ?? new Date();
  let a: CliAccounts | null;
  try {
    a = await deps.accounts();
  } catch (err) {
    console.error(`armada dashboard: sign-in unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return refuse(503, "Armada cannot check sign-ins right now", "the same command again in a moment");
  }
  if (!a)
    return refuse(
      503,
      "this Armada has no accounts yet (it runs on the shared dashboard password), so a terminal cannot sign in to it",
      "ask its owner to set up accounts (the ARMADA_AUTH_* variables); until then, keep the keys in `armada auth login`",
    );

  const route = `${request.method} ${path.join("/")}`;
  if (route === "POST device/code") return forward(a, request, "/device/code", {});
  if (route === "POST device/token") {
    const code = (await jsonBody(request)).device_code;
    if (typeof code !== "string" || !code)
      return Response.json({ error: "invalid_request", error_description: "device_code is required" }, { status: 400 });
    return forward(a, request, "/device/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: code,
    });
  }
  if (route === "GET session") {
    const identity = await identify(a, credentialOf(request), now);
    if (identity instanceof Response) return identity;
    const { launch: _, ...shown } = identity;
    return Response.json(shown, { headers: NO_STORE });
  }
  if (route === "POST credentials") return credentials(a, request, deps, now);
  if (route === "POST launch-tokens") return launch(a, request, deps, now);
  if (route === "POST launch-tokens/exchange") return exchange(a, request, now);
  if (route === "POST workers/end") return endWorkers(a, request, now);
  if (route === "GET projects") return projects(a, request, now);
  if (request.method === "POST" && path[0] === "fleet" && path.length > 1)
    return fleet(a, request, path.slice(1).join("/"), deps);
  if (route === "DELETE session") {
    const credential = credentialOf(request);
    if (credential?.kind === "api-key")
      return refuse(400, "an API key is not signed out: it is revoked in the app", "the Organization page of Armada");
    if (credential?.kind === "worker") {
      // A worker signs out when it releases its ticket: its session ends for good.
      const identity = await identify(a, credential, now);
      if (!(identity instanceof Response) && identity.launch)
        await endWorker(a.client, {
          organization: identity.launch.organization,
          id: identity.launch.id,
          reason: "released",
          by: workerActor(identity.launch),
          now,
        });
      return Response.json({ signedOut: true }, { headers: NO_STORE });
    }
    // Idempotent: an unknown or already revoked token is signed out all the same.
    if (credential) await (await a.auth.$context).internalAdapter.deleteSession(credential.token);
    return Response.json({ signedOut: true }, { headers: NO_STORE });
  }
  return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
}
