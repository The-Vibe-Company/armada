import { type AuthStore, createSqlAuthStore, createServiceToken, listServiceTokens, refreshSupabaseSession, exchangeSupabaseCode, sendEmailLink, verifyEmailCode, assertEmail, assertEmailCode, supabaseAuthorizeUrl, assertProvider, type Session } from "@armada/auth";
import {
  addMember,
  connectGolden,
  snapshotGolden,
  scanGoldenSandbox,
  createGoldenCreateService,
  createOrg,
  createSqlVaultStore,
  ENCRYPTION_KEY_ENV,
  EncryptionKeyError,
  type GitHubAccess,
  type GitHubApp,
  type GoldenActor,
  type GoldenCreateService,
  GoldenError,
  type GoldenErrorCode,
  type GoldenRecord,
  githubAppFromEnv,
  githubInstallationAppFromEnv,
  goldenForLaunch,
  type LaunchOptions,
  type LaunchResult,
  launchSandbox,
  listCredentials,
  listMembers,
  listOrgs,
  normalizeGitHubGoldenConfig,
  type Provider,
  parseCredentialKind,
  parseGoldenConfig,
  parseRole,
  promptOutcome,
  removeCredential,
  removeMember,
  resolveBoatKey,
  resolveCredentials,
  resolveGitHubAccess,
  resolveOrg,
  setCredential,
  setMemberRole,
  VaultError,
  type VaultErrorCode,
  type VaultStore,
  type Visibility,
} from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { AuthUnavailable, authenticateCaller, type Caller, type SupabaseProject } from "./caller.ts";
import type { DataSource, ScopedData } from "./data.ts";
import { launchCredentials } from "./launch-credentials.ts";
import { bunSql } from "./sql.ts";

export const CONTROL_PREFIX = "/api/v1/";
const MAX_BODY_BYTES = 128 * 1024;

export interface ControlOptions {
  /** Same verified bearer dependencies as MCP: Armada service/OAuth tokens and Supabase sessions. */
  authStore: AuthStore;
  supabase: SupabaseProject;
  now?: () => Date;
  /** Scoped golden/sandbox queries shared with MCP. */
  data?: DataSource;
  vault?: VaultStore;
  launch?: LaunchOptions;
  /** Service-role access: orgs, members and ciphertext. See `createSqlVaultStore`. */
  store: VaultStore;
  /**
   * `ARMADA_ENCRYPTION_KEY`. Writes encrypt with it. `launch/resolve` also decrypts, and returns the
   * plaintext to the signed-in user's own machine, which is where the launch runs. Nothing is logged.
   */
  encryptionKey: string | undefined;
  /** The GitHub App, for `launch/resolve`. Null or absent: GitHub is reported as not set up. */
  github?: { app: GitHubApp | null; fetch?: typeof fetch; now?: () => Date };
  /** Resolves a visible Armada sandbox to its provider. The Boat key stays on the server. */
  logs?: (caller: Caller, sandboxId: string) => Promise<{ provider: Provider; boatId: string }>;
  /** Secure, server-orchestrated multi-repo golden creation (`armada golden create --name`). Absent: the route refuses. */
  goldenCreate?: GoldenCreateService;
  /** A provider for one boat.dev key, for `golden/create`. The key is used in this process only. */
  providerFor?: (apiKey: string) => Provider;
  /** Server-side native-session refresh; never exposed to the CLI. */
  refreshNative?: (refreshToken: string) => Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>;
  exchangeNative?: (code: string, verifier: string) => Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>;
}

const STATUS: Record<VaultErrorCode, number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  missing_credential: 404,
  conflict: 409,
  unavailable: 503,
};

const GOLDEN_STATUS: Record<GoldenErrorCode, number> = {
  invalid_config: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  setup_failed: 502,
  snapshot_failed: 502,
};

/**
 * The CLI's way to the things that need the server: org creation and email lookup (service role)
 * and credential encryption (the encryption key). Every call is a POST with the person's Supabase
 * bearer accepted by MCP (Armada service/OAuth token or verified Supabase session); the answer is JSON. Returns null for any other path, so #464 mounts
 * this next to the OAuth routes. No request body, token or credential value is logged.
 */
export async function handleControlRequest(request: Request, options: ControlOptions): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(CONTROL_PREFIX)) return null;
  const route = url.pathname.slice(CONTROL_PREFIX.length);
  if (route === "auth/authorize") return authorizeRoute(request, options);
  if (route === "auth/exchange") return exchangeRoute(request, options);
  if (route === "auth/email/start") return emailStartRoute(request, options);
  if (route === "auth/email/verify") return emailVerifyRoute(request, options);
  if (route === "token/list") return tokenListRoute(request, options);
  if (route === "token/create") return tokenCreateRoute(request, options);
  if (route === "auth/refresh") return refreshRoute(request, options);
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const caller = await authenticatedCaller(request, options);
    const body = await readBody(request);
    const result = await dispatch(route, caller, body, options);
    if (result === undefined) return fail(404, "not_found", "Unknown route.");
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Unauthorized) return fail(401, "unauthorized", error.message);
    if (error instanceof AuthUnavailable) return fail(503, "unavailable", "Authentication is temporarily unavailable.");
    if (error instanceof VaultError) return fail(STATUS[error.code], error.code, error.message);
    if (error instanceof GoldenError) return fail(GOLDEN_STATUS[error.code], error.code, error.message);
    if (error instanceof EncryptionKeyError) {
      return fail(503, "unavailable", `Credential encryption is not configured on the server (${ENCRYPTION_KEY_ENV}).`);
    }
    return fail(500, "unavailable", "The server could not complete the request.");
  }
}

async function tokenCreateRoute(request: Request, options: ControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const caller = await authenticatedCaller(request, options);
    const body = await readBody(request);
    const org = optional(body, "org");
    if (caller.via === "service") {
      const scope = caller.orgs[0];
      if (!scope || !org) return fail(403, "forbidden", "A scoped token cannot create an unscoped token.");
      const memberships = await options.authStore.memberships(caller.userId);
      const membership = memberships.find((item) => item.orgId === scope.orgId);
      if (!membership || membership.name !== org) return fail(403, "forbidden", "This token is scoped to another org.");
    }
    const created = await createServiceToken(options.authStore, { userId: caller.userId, ...(org ? { orgName: org } : {}), ...(optional(body, "label") ? { label: optional(body, "label")! } : {}), now: (options.now ?? (() => new Date()))() });
    return Response.json({ id: created.id, label: created.label, orgName: created.orgName, token: created.token }, { headers: { "cache-control": "no-store" } });
  } catch {
    return fail(401, "unauthorized", "Token creation was refused.");
  }
}

async function tokenListRoute(request: Request, options: ControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const caller = await authenticatedCaller(request, options);
    const tokens = await listServiceTokens(options.authStore, caller.userId);
    const allowed = caller.via === "service" ? new Set(caller.orgs.map((org) => org.orgId)) : null;
    const memberships = allowed ? await options.authStore.memberships(caller.userId) : [];
    const names = new Set(memberships.filter((membership) => allowed?.has(membership.orgId)).map((membership) => membership.name));
    return Response.json({ tokens: tokens.filter((token) => !allowed || names.has(token.orgName)).map(({ id, label, orgName, createdAt, revokedAt }) => ({ id, label, orgName, createdAt, revokedAt })) }, { headers: { "cache-control": "no-store" } });
  } catch {
    return fail(401, "unauthorized", "Run armada login.");
  }
}

async function emailVerifyRoute(request: Request, options: ControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const body = await readBody(request);
    const email = assertEmail(required(body, "email"));
    const code = assertEmailCode(required(body, "code"));
    const session = await verifyEmailCode({
      fetch: options.supabase.fetch ?? fetch,
      supabaseUrl: options.supabase.supabaseUrl,
      anonKey: options.supabase.anonKey,
      email,
      code,
      now: options.now?.() ?? new Date(),
    });
    return Response.json({ accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt }, { headers: { "cache-control": "no-store" } });
  } catch {
    return fail(401, "unauthorized", "Email code was refused.");
  }
}

async function emailStartRoute(request: Request, options: ControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const body = await readBody(request);
    const email = assertEmail(required(body, "email"));
    const redirectTo = required(body, "redirect_uri");
    const challenge = required(body, "code_challenge");
    const state = required(body, "state");
    const callback = new URL(redirectTo);
    if (callback.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(callback.hostname) || !callback.port || callback.username || callback.password || callback.hash || !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge) || !/^[A-Za-z0-9._~-]{8,512}$/.test(state)) throw new Error();
    await sendEmailLink({ fetch: options.supabase.fetch ?? fetch, supabaseUrl: options.supabase.supabaseUrl, anonKey: options.supabase.anonKey, email, redirectTo: callback.toString(), challenge });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof Error && error.message.includes("Too many") ? 429 : 400;
    return fail(status, status === 429 ? "rate_limited" : "invalid", status === 429 ? "Try again later." : "Invalid email login request.");
  }
}

async function exchangeRoute(request: Request, options: ControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const body = await readBody(request);
    const code = required(body, "code");
    const verifier = required(body, "verifier");
    if (code.length > 4096 || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new VaultError("invalid", "Invalid login exchange.");
    const result = options.exchangeNative
      ? await options.exchangeNative(code, verifier)
      : await nativeExchange(options, code, verifier);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof VaultError) return fail(400, error.code, error.message);
    return fail(401, "unauthorized", "Login exchange was refused.");
  }
}

async function nativeExchange(options: ControlOptions, code: string, verifier: string) {
  const session = await exchangeSupabaseCode({
    fetch: options.supabase.fetch ?? fetch,
    supabaseUrl: options.supabase.supabaseUrl,
    anonKey: options.supabase.anonKey,
    code,
    verifier,
    now: options.now?.() ?? new Date(),
  });
  return { accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt };
}

function authorizeRoute(request: Request, options: ControlOptions): Response {
  if (request.method !== "GET") return fail(405, "invalid", "Use GET.");
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") ?? "";
  const redirectTo = url.searchParams.get("redirect_uri") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  const state = url.searchParams.get("state") ?? "";
  try {
    assertProvider(provider);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(challenge) || !/^[A-Za-z0-9._~-]{8,512}$/.test(state)) throw new Error();
    const callback = new URL(redirectTo);
    if (callback.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(callback.hostname) || !callback.port || callback.username || callback.password || callback.hash) throw new Error();
    const location = supabaseAuthorizeUrl({ supabaseUrl: options.supabase.supabaseUrl, anonKey: options.supabase.anonKey, provider: assertProvider(provider), redirectTo: callback.toString(), challenge });
    return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
  } catch {
    return fail(400, "invalid", "Invalid browser login request.");
  }
}

async function refreshRoute(request: Request, options: ControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const body = await readBody(request);
    const token = required(body, "refreshToken");
    const refreshed = options.refreshNative
      ? await options.refreshNative(token)
      : await nativeRefresh(options, token);
    return Response.json(refreshed, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof VaultError) return fail(400, error.code, error.message);
    return fail(401, "unauthorized", "Refresh token was refused.");
  }
}

async function nativeRefresh(options: ControlOptions, refreshToken: string) {
  const session: Session = {
    supabaseUrl: options.supabase.supabaseUrl,
    anonKey: options.supabase.anonKey,
    accessToken: "expired",
    refreshToken,
    expiresAt: new Date(0).toISOString(),
    userId: "",
  };
  const next = await refreshSupabaseSession({ fetch: options.supabase.fetch ?? fetch, anonKey: options.supabase.anonKey, session, now: options.now?.() ?? new Date() });
  return { accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt };
}

async function dispatch(
  route: string,
  caller: Caller,
  body: Record<string, unknown>,
  options: ControlOptions,
): Promise<unknown> {
  const { store, encryptionKey } = options;
  const userId = caller.userId;
  const org = scopedOrg(caller, optional(body, "org"));
  switch (route) {
    case "org/create":
      return { org: await createOrg(store, userId, required(body, "name")) };
    case "org/list":
      return { orgs: await listOrgs(store, userId) };
    case "members/list":
      return listMembers(store, userId, org);
    case "members/add":
      return {
        member: await addMember(store, userId, {
          org,
          email: required(body, "email"),
          role: parseRole(optional(body, "role") ?? "member"),
        }),
      };
    case "members/role":
      await setMemberRole(store, userId, {
        org,
        email: required(body, "email"),
        role: parseRole(required(body, "role")),
      });
      return { ok: true };
    case "members/remove":
      await removeMember(store, userId, { org, email: required(body, "email") });
      return { ok: true };
    case "creds/set":
      await setCredential(store, encryptionKey, userId, {
        scope: scope(body),
        org,
        kind: parseCredentialKind(required(body, "kind")),
        value: required(body, "value"),
      });
      return { ok: true };
    case "creds/list":
      return listCredentials(store, userId, org);
    case "creds/rm":
      await removeCredential(store, userId, {
        scope: scope(body),
        org,
        kind: parseCredentialKind(required(body, "kind")),
      });
      return { ok: true };
    case "sandbox/launch":
      return launchRoute(options, caller, body);
    case "launch/resolve":
      return resolveLaunch(options, caller, body, org);
    case "logs/read":
      return readLogs(options, caller, required(body, "id"), body);
    case "golden/list":
      return listGoldens(options, caller);
    case "golden/create":
      return createGoldenRoute(options, caller, body);
    case "golden/update":
      return updateGoldenRoute(options, caller, body);
    case "golden/snapshot":
      return snapshotGoldenRoute(options, caller, body);
    case "golden/connect":
      return connectGoldenRoute(options, caller, body);
    default:
      return undefined;
  }
}

/** The same visibility-filtered representation returned by MCP golden_list. */
async function listGoldens(options: ControlOptions, caller: Caller): Promise<{ goldens: GoldenJson[] }> {
  if (!options.data) throw new VaultError("unavailable", "Golden listing is not configured on this server.");
  const data = options.data(caller);
  const goldens = [];
  for (const { orgId } of caller.orgs) goldens.push(...(await data.goldens.list(orgId)));
  return { goldens: goldens.map(goldenJson) };
}

export interface GoldenJson {
  name: string;
  orgId: string;
  visibility: Visibility;
  ownerId: string;
  boatSnapshotId: string | null;
  boatSandboxId: string | null;
  repos: number;
  config: { repos: { url: string; branch: string; dir: string }[]; init: string[] };
}

function goldenJson(row: import("@armada/core/server").GoldenRecord): GoldenJson {
  return {
    name: row.name,
    orgId: row.orgId,
    visibility: row.visibility,
    ownerId: row.ownerId,
    boatSnapshotId: row.boatSnapshotId,
    boatSandboxId: row.boatSandboxId,
    repos: row.config.repos.length,
    config: row.config,
  };
}

/**
 * `armada golden create --name`: securely builds a golden from one or more GitHub repositories in a
 * disposable, no-env builder, over the caller's own cached GitHub connection, and persists it only
 * once a fail-closed secret scan and the snapshot both succeed. The caller needs no boat.dev key.
 */
async function createGoldenRoute(
  options: ControlOptions,
  caller: Caller,
  body: Record<string, unknown>,
): Promise<{ name: string; visibility: Visibility; snapshot: string }> {
  if (!options.goldenCreate || !options.providerFor) {
    throw new VaultError("unavailable", "Secure golden creation is not configured on this server.");
  }
  const org = await resolveOrg(options.store, caller.userId, scopedOrg(caller, optional(body, "org")));
  const visibility: Visibility = requiredBoolean(body, "private", false) ? "private" : "org";
  const name = required(body, "name");
  const config = body.config === undefined ? undefined : normalizeGitHubGoldenConfig(parseGoldenConfig(body.config));
  const repos = config ? [] : requiredStringArray(body, "repos");
  const setup = optional(body, "setup");
  const actor: GoldenActor = { userId: caller.userId, orgId: org.id, role: org.role };
  const boat = await resolveBoatKey(options.store, options.encryptionKey, {
    userId: caller.userId,
    orgId: org.id,
    visibility,
  });
  const result = await options.goldenCreate.create(options.providerFor(boat.key), actor, {
    name,
    visibility,
    repos,
    ...(config === undefined ? {} : { config }),
    ...(setup !== undefined ? { setup } : {}),
  });
  return { name, visibility, snapshot: result.snapshot };
}

/** Rebuild an existing visible golden in place. The row, owner and visibility come from storage, never the body. */
async function updateGoldenRoute(
  options: ControlOptions,
  caller: Caller,
  body: Record<string, unknown>,
): Promise<{ name: string; visibility: Visibility; snapshot: string }> {
  if (!options.goldenCreate || !options.providerFor || !options.data)
    throw new VaultError("unavailable", "Secure golden creation is not configured on this server.");
  const org = await resolveOrg(options.store, caller.userId, scopedOrg(caller, optional(body, "org")));
  const name = required(body, "name");
  const rows = await options.data(caller).goldens.findByName(org.id, name);
  if (rows.length !== 1) throw new GoldenError("not_found", `No golden named '${name}'.`);
  const existingGolden = rows[0];
  if (!existingGolden) throw new GoldenError("not_found", `No golden named '${name}'.`);
  const actor: GoldenActor = { userId: caller.userId, orgId: org.id, role: org.role };
  if (body.config === undefined) throw new VaultError("invalid", "config is required.");
  const config = normalizeGitHubGoldenConfig(parseGoldenConfig(body.config));
  const boat = await resolveBoatKey(options.store, options.encryptionKey, {
    userId: caller.userId,
    orgId: org.id,
    visibility: existingGolden.visibility,
  });
  const result = await options.goldenCreate.create(options.providerFor(boat.key), actor, {
    name: existingGolden.name,
    visibility: existingGolden.visibility,
    repos: [],
    config,
    ...(optional(body, "setup") === undefined ? {} : { setup: optional(body, "setup")! }),
    existingGolden,
  });
  return { name: existingGolden.name, visibility: existingGolden.visibility, snapshot: result.snapshot };
}

async function snapshotGoldenRoute(
  options: ControlOptions,
  caller: Caller,
  body: Record<string, unknown>,
): Promise<{ name: string; snapshot: string }> {
  if (!options.providerFor || !options.data) throw new VaultError("unavailable", "Golden snapshots are not configured on this server.");
  const org = await resolveOrg(options.store, caller.userId, scopedOrg(caller, optional(body, "org")));
  const name = required(body, "name");
  const data = options.data(caller);
  const rows = await data.goldens.findByName(org.id, name);
  if (rows.length !== 1 || !rows[0]) throw new GoldenError("not_found", `No golden named '${name}'.`);
  const golden = rows[0];
  const actor: GoldenActor = { userId: caller.userId, orgId: org.id, role: org.role };
  // Core methods re-check the exact private-owner/org-admin policy before changing anything.
  const boat = await resolveBoatKey(options.store, options.encryptionKey, {
    userId: caller.userId, orgId: org.id, visibility: golden.visibility,
  });
  const provider = options.providerFor(boat.key);
  let target = golden;
  if (!target.boatSandboxId) {
    const restored = await connectGolden(provider, data.goldens, actor, target.name);
    target = restored.golden;
  }
  if (!target.boatSandboxId) throw new GoldenError("conflict", `Golden '${target.name}' has no sandbox yet.`);
  await scanGoldenSandbox(provider, target.boatSandboxId);
  const saved = await snapshotGolden(provider, data.goldens, actor, target.name, options.launch ?? {});
  return { name: saved.golden.name, snapshot: saved.snapshotName };
}

async function connectGoldenRoute(options: ControlOptions, caller: Caller, body: Record<string, unknown>) {
  const org = await resolveOrg(options.store, caller.userId, scopedOrg(caller, optional(body, "org")));
  if (!options.providerFor) throw new VaultError("unavailable", "Golden connection is not configured on this server.");
  const name = required(body, "name");
  const data = options.data?.(caller);
  if (!data) throw new VaultError("unavailable", "Golden connection is not configured on this server.");
  const rows = await data.goldens.findByName(org.id, name);
  const golden = rows[0];
  if (!golden) throw new GoldenError("not_found", `No golden named '${name}'.`);
  const boat = await resolveBoatKey(options.store, options.encryptionKey, {
    userId: caller.userId,
    orgId: org.id,
    visibility: golden.visibility,
  });
  const actor: GoldenActor = { userId: caller.userId, orgId: org.id, role: org.role };
  const connected = await connectGolden(options.providerFor(boat.key), data.goldens, actor, name);
  return { golden: connected.golden.name, sandboxId: connected.sandbox.id, webUrl: null };
}

async function readLogs(
  options: ControlOptions,
  caller: Caller,
  id: string,
  body: Record<string, unknown>,
): Promise<{
  events: Awaited<ReturnType<Provider["events"]>>["events"];
  cursor: string | null;
  hasMore: boolean;
  settled: boolean;
}> {
  if (!options.logs) throw new VaultError("unavailable", "Sandbox logs are not configured on the server.");
  const target = await options.logs(caller, id);
  const all = body.all === true;
  const follow = body.follow === true;
  const maxPages = 100;
  let cursor = optional(body, "cursor");
  let hasMore = false;
  const events: Awaited<ReturnType<Provider["events"]>>["events"] = [];
  for (let pageNumber = 0; pageNumber < (all ? maxPages : 1); pageNumber += 1) {
    const page = await target.provider.events({ sandboxId: target.boatId, ...(cursor ? { cursor } : {}) });
    events.push(...page.events);
    hasMore = page.hasMore;
    const next = page.cursor ?? cursor;
    if (!page.hasMore || !next || next === cursor) {
      cursor = next;
      break;
    }
    cursor = next;
  }
  const info = await target.provider.get(target.boatId);
  const latest = latestPrompt(events);
  // A live sandbox with no turn is idle, so following has nothing to wait for.
  const outcome = latest ? await promptOutcome(target.provider, { sandboxId: target.boatId, promptId: latest }) : null;
  return {
    events: dedupe(events),
    cursor: cursor ?? null,
    hasMore,
    settled:
      !follow ||
      info.state === "stopped" ||
      info.state === "failed" ||
      (latest === null ? info.state !== "running" && info.state !== "starting" : outcome?.state !== "running"),
  };
}

function latestPrompt(events: Awaited<ReturnType<Provider["events"]>>["events"]): string | null {
  let latest: (typeof events)[number] | undefined;
  for (const event of events) {
    if (event.kind !== "prompt" || !event.promptId) continue;
    if (!latest || event.at >= latest.at) latest = event;
  }
  return latest?.promptId ?? null;
}

function dedupe<T extends { id: string }>(events: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const event of events) byId.set(event.id, event);
  return [...byId.values()];
}

async function launchRoute(options: ControlOptions, caller: Caller, body: Record<string, unknown>): Promise<unknown> {
  if (!options.data || !options.providerFor)
    throw new VaultError("unavailable", "Launching is not configured on this server.");
  const name = required(body, "golden");
  const harness = required(body, "harness");
  if (harness !== "claude" && harness !== "codex") throw new VaultError("invalid", "The agent is claude or codex.");
  const data = options.data(caller);
  const actor = await launchActor(data, caller, name, optional(body, "org"));
  const golden = await goldenForLaunch(data.goldens, actor, name);
  const provider = await providerForGolden(options, caller, golden);
  const result = await launchSandbox(
    provider,
    {
      goldens: data.goldens,
      sandboxes: data.sandboxes,
      credentials: launchCredentials(options.store, options.encryptionKey, {
        store: options.store,
        app: options.github?.app ?? null,
        ...(options.github?.fetch ? { fetch: options.github.fetch } : {}),
        ...(options.github?.now ? { now: options.github.now } : {}),
      }),
    },
    actor,
    {
      golden: name,
      harness,
      ...(optional(body, "prompt") === undefined ? {} : { prompt: required(body, "prompt") }),
      ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: requiredNumber(body, "ttlSeconds") }),
    },
    options.launch ?? {},
  );
  return launchJson(result);
}

async function launchActor(
  data: ScopedData,
  caller: Caller,
  name: string,
  org: string | undefined,
): Promise<GoldenActor> {
  const selected = org === undefined ? undefined : scopedOrg(caller, org);
  if (selected !== undefined) {
    const member = caller.orgs.find((item) => item.orgId === selected);
    if (!member) throw new VaultError("forbidden", "This token is scoped to another org.");
    return { userId: caller.userId, orgId: member.orgId, role: member.role };
  }
  const holders: string[] = [];
  for (const member of caller.orgs)
    if ((await data.goldens.findByName(member.orgId, name)).length > 0) holders.push(member.orgId);
  if (holders.length > 1) throw new VaultError("invalid", "Name the org for this golden.");
  const member = caller.orgs.find((item) => item.orgId === (holders[0] ?? caller.orgs[0]?.orgId));
  if (!member) throw new VaultError("not_found", "You are not a member of an org.");
  return { userId: caller.userId, orgId: member.orgId, role: member.role };
}

async function providerForGolden(options: ControlOptions, caller: Caller, golden: GoldenRecord): Promise<Provider> {
  const key = await resolveBoatKey(options.store, options.encryptionKey, {
    userId: caller.userId,
    orgId: golden.orgId,
    visibility: golden.visibility,
  });
  return (
    options.providerFor?.(key.key) ??
    Promise.reject(new VaultError("unavailable", "Launching is not configured on this server."))
  );
}

function launchJson(result: LaunchResult) {
  return {
    sandbox: result.sandbox,
    golden: result.golden,
    promptId: result.promptId ?? null,
    conversationId: result.conversationId ?? null,
    ttlSeconds: result.ttlSeconds,
    expiresAt: result.expiresAt?.toISOString() ?? null,
    github: {
      status: result.github.status,
      login: result.github.login ?? null,
      message: result.github.message ?? null,
    },
  };
}

async function resolveLaunch(
  options: ControlOptions,
  caller: Caller,
  body: Record<string, unknown>,
  orgRef: string | undefined,
): Promise<{ env: Record<string, string>; codexAuth: string | null; boatKey: string; github: GitHubAccess }> {
  const { store, encryptionKey } = options;
  const userId = caller.userId;
  const org = await resolveOrg(store, userId, scopedOrg(caller, orgRef));
  const harness = required(body, "harness");
  if (harness !== "claude" && harness !== "codex") throw new VaultError("invalid", "The agent is claude or codex.");
  const visibility = required(body, "visibility");
  if (visibility !== "org" && visibility !== "private")
    throw new VaultError("invalid", "Visibility is org or private.");
  const resolved = await resolveCredentials(store, encryptionKey, { userId, orgId: org.id, harness });
  const boat = await resolveBoatKey(store, encryptionKey, { userId, orgId: org.id, visibility });
  const github = await resolveGitHubAccess(
    {
      store,
      encryptionKey,
      app: options.github?.app ?? null,
      ...(options.github?.fetch ? { fetch: options.github.fetch } : {}),
      ...(options.github?.now ? { now: options.github.now } : {}),
    },
    userId,
  );
  return { env: resolved.env, codexAuth: resolved.files[0]?.content ?? null, boatKey: boat.key, github };
}

class Unauthorized extends Error {}

/** Shared MCP/control bearer boundary. Callers receive only the orgs embedded in the verified principal. */
export async function authenticatedControlCaller(request: Request, options: ControlOptions): Promise<Caller | null> {
  const result = await authenticateCaller(request.headers.get("authorization"), {
    store: options.authStore,
    supabase: options.supabase,
    now: (options.now ?? (() => new Date()))(),
  });
  return result.ok ? result.caller : null;
}

async function authenticatedCaller(request: Request, options: ControlOptions): Promise<Caller> {
  const caller = await authenticatedControlCaller(request, options);
  if (!caller) throw new Unauthorized("Run armada login.");
  return caller;
}

/** A service/OAuth token has exactly one org; never widen that scope from database memberships. */
function scopedOrg(caller: Caller, requested: string | undefined): string | undefined {
  if (caller.via === "supabase") return requested;
  const orgId = caller.orgs[0]?.orgId;
  if (!orgId) throw new Unauthorized("Run armada login.");
  if (requested !== undefined && requested.trim() !== "" && requested.trim().toLowerCase() !== orgId) {
    throw new VaultError("forbidden", "This token is scoped to another org.");
  }
  return orgId;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new VaultError("invalid", "The request is too large.");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VaultError("invalid", "The request is not JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new VaultError("invalid", "The request is not a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function optional(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new VaultError("invalid", `${key} must be text.`);
  return value;
}

function required(body: Record<string, unknown>, key: string): string {
  const value = optional(body, key);
  if (value === undefined) throw new VaultError("invalid", `${key} is required.`);
  return value;
}

function requiredStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item !== "")) {
    throw new VaultError("invalid", `${key} must be a non-empty array of non-empty strings.`);
  }
  return value;
}

function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new VaultError("invalid", `${key} must be a positive integer.`);
  return value;
}

function requiredBoolean(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new VaultError("invalid", `${key} must be a boolean.`);
  return value;
}

function scope(body: Record<string, unknown>): "user" | "org" {
  const value = required(body, "scope");
  if (value === "user" || value === "org") return value;
  throw new VaultError("invalid", "scope is user or org.");
}

function fail(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Wires the control API from the environment: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
 * `ARMADA_DATABASE_URL` (a privileged Postgres connection string, the Supabase `postgres` role)
 * and `ARMADA_ENCRYPTION_KEY`.
 */
export function controlOptionsFromEnv(env: Record<string, string | undefined>): ControlOptions {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Set ${name}.`);
    return value;
  };
  // The same adapter `armada serve` uses (`sql.ts`'s `bunSql`), not a hand-rolled one: it wires
  // `.transaction` to `Bun.SQL.begin`, which `withGitHubConnectionRefresh`'s advisory lock (#492)
  // needs to actually serialize concurrent refreshes. Without it, that lock is silently skipped.
  const sql = bunSql(need("ARMADA_DATABASE_URL"));
  const encryptionKey = need(ENCRYPTION_KEY_ENV);
  const githubApp = githubAppFromEnv(env);
  const store = createSqlVaultStore(sql);
  const authStore = createSqlAuthStore(sql);
  const supabaseUrl = need("SUPABASE_URL");
  const anonKey = need("SUPABASE_ANON_KEY");
  return {
    authStore,
    supabase: { supabaseUrl, anonKey },
    encryptionKey,
    github: { app: githubApp },
    store,
    providerFor: (apiKey) => createBoatProvider({ apiKey }),
    goldenCreate: createGoldenCreateService({
      sql,
      github: { store, encryptionKey, app: githubApp },
      installationApp: githubInstallationAppFromEnv(env),
    }),
  };
}
