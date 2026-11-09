import {
  type AuthStore,
  assertEmail,
  assertEmailCode,
  assertProvider,
  createServiceToken,
  createSqlAuthStore,
  exchangeSupabaseCode,
  listServiceTokens,
  refreshSupabaseSession,
  revokeServiceToken,
  type Session,
  sendEmailLink,
  supabaseAuthorizeUrl,
  verifyEmailCode,
} from "@armada/auth";
import { goldenForSettings, parseMachineSize, parseMachineSizePolicy } from "@armada/core";
import {
  addMember,
  assertGoldenMutation,
  connectGolden,
  createGoldenAdoption,
  createOrg,
  createSqlMcpLaunchPort,
  createSqlMcpRegistry,
  createSqlVaultStore,
  ENCRYPTION_KEY_ENV,
  EncryptionKeyError,
  type GitHubApp,
  type GoldenActor,
  GoldenBuildJobs,
  GoldenError,
  type GoldenErrorCode,
  type GoldenRecord,
  githubAppFromEnv,
  githubInstallationAppFromEnv,
  goldenForLaunch,
  isSandboxProvider,
  LaunchError,
  type LaunchOptions,
  type LaunchResult,
  type LaunchStores,
  launchSandbox,
  listCredentials,
  listMembers,
  listOrgs,
  type McpBrokerPort,
  type McpConnectionInput,
  type McpRegistry,
  type ModelChoice,
  mutateCredentialAccount,
  normalizeGitHubGoldenConfig,
  type Provider,
  ProviderError,
  type ProviderRegistry,
  ProviderRoutingError,
  type ProviderTarget,
  parseCredentialKind,
  parseGoldenConfig,
  parseRole,
  promptOutcome,
  removeCredential,
  removeMember,
  resolveBoatKey,
  resolveModelChoice,
  resolveOrg,
  resolveRepositoryDir,
  scanGoldenSandbox,
  setCredential,
  setMemberRole,
  snapshotGolden,
  VaultError,
  type VaultErrorCode,
  type VaultStore,
  type Visibility,
} from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { GatewayError } from "../../mcp-gateway/src/network.ts";
import { AuthUnavailable, authenticateCaller, type Caller, type SupabaseProject } from "./caller.ts";
import { createSqlData, type DataSource, type ScopedData } from "./data.ts";
import type { GitHubAccountApi } from "./github-account.ts";
import { providerRegistry } from "./http.ts";
import { InvitationError, type Invitations, invitationsFromEnv } from "./invitations.ts";
import { exposedSecrets, launchCredentials } from "./launch-credentials.ts";
import { catalogAuthenticationFromEnv } from "./mcp-catalog-client.ts";
import { createModalIntegration } from "./modal-integration.ts";
import { createModelUsageApi, isPrivateModelEvent, type ModelUsageApi } from "./model-usage.ts";
import {
  connectOrgProvider,
  disconnectOrgProvider,
  orgProviderStatus,
  type ProviderValidator,
  validateOrgProvider,
} from "./org-provider.ts";
import type { ProviderMetadataFor } from "./provider-metadata.ts";
import { createProviderMetadata } from "./provider-metadata.ts";
import { bunSql } from "./sql.ts";
import { callSharedTool, ToolApiError } from "./tool-api.ts";

export const CONTROL_PREFIX = "/api/v1/";
const MAX_BODY_BYTES = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ControlOptions {
  modelUsage?: ModelUsageApi;
  invitations?: Invitations;
  providerValidator?: ProviderValidator;
  githubAccount?: GitHubAccountApi;
  goldenRetirements?: import("@armada/core/server").GoldenSnapshotRetirements;
  mcp?: { registry: McpRegistry; broker?: McpBrokerPort };
  connections?: LaunchStores["connections"];
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
  logs?: (caller: Caller, sandboxId: string) => Promise<{ provider: Provider; providerSandboxId: string }>;
  /** Secure, server-orchestrated multi-repo golden creation (`armada golden create --name`). Absent: the route refuses. */
  goldenBuilds?: GoldenBuildJobs;
  goldenAdoption?: import("@armada/core/server").GoldenAdoption;
  /** A provider for one boat.dev key, for `golden/create`. The key is used in this process only. */
  providers?: ProviderRegistry;
  providerMetadata?: ProviderMetadataFor;
  goldenTarget?: (target: Omit<ProviderTarget, "modal">, caller: { userId: string }) => Promise<ProviderTarget>;
  providerFor?: (apiKey: string, caller?: { userId: string; orgId: string }) => Provider;
  /** Server-side native-session refresh; never exposed to the CLI. */
  refreshNative?: (refreshToken: string) => Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>;
  exchangeNative?: (
    code: string,
    verifier: string,
  ) => Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>;
}

const STATUS: Record<VaultErrorCode, number> = {
  credential_binding_required: 409,
  credential_binding_unsafe: 409,
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
  build_failed: 502,
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
  if (route === "github/oauth/callback") {
    if (request.method !== "GET" && request.method !== "POST") return fail(405, "invalid", "Use POST or GET.");
    return options.githubAccount
      ? options.githubAccount.callback(request)
      : fail(503, "unavailable", "GitHub account authorization is not configured.");
  }
  if (route === "auth/authorize") return authorizeRoute(request, options);
  if (route === "auth/exchange") return exchangeRoute(request, options);
  if (route === "auth/email/start") return emailStartRoute(request, options);
  if (route === "auth/email/verify") return emailVerifyRoute(request, options);
  if (route === "token/list") return tokenListRoute(request, options);
  if (route === "token/create") return tokenCreateRoute(request, options);
  if (route === "token/revoke") return tokenRevokeRoute(request, options);
  if (route === "auth/refresh") return refreshRoute(request, options);
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const caller = await authenticatedCaller(request, options);
    const body = await readBody(request);
    if (route === "account/logout") {
      if (caller.via !== "supabase")
        throw new VaultError("forbidden", "Use a personal login session to sign out remotely.");
      const response = await (options.supabase.fetch ?? fetch)(
        new URL("/auth/v1/logout?scope=local", options.supabase.supabaseUrl),
        {
          method: "POST",
          headers: { apikey: options.supabase.anonKey, authorization: request.headers.get("authorization") ?? "" },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new VaultError("unavailable", "The account session could not be signed out.");
      return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    }
    const invitationAction = route.startsWith("org/invitations/") ? route.slice("org/invitations/".length) : null;
    let result: unknown;
    if (invitationAction) {
      if (!options.invitations) throw new VaultError("unavailable", "Invitations unavailable.");
      result =
        invitationAction === "preview"
          ? await options.invitations.preview(caller, body.token)
          : invitationAction === "accept"
            ? await options.invitations.accept(caller, body.token)
            : await options.invitations.manage(invitationAction, caller, required(body, "org"), body);
    } else result = await dispatch(route, caller, body, options);
    if (result === undefined) return fail(404, "not_found", "Unknown route.");
    return Response.json(result, {
      status:
        (route === "golden/create" || route === "golden/update") &&
        typeof result === "object" &&
        result !== null &&
        "jobId" in result
          ? 202
          : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof GatewayError) {
      const status =
        error.code === "denied" ? 403 : error.code === "busy" ? 409 : error.code === "upstream" ? 502 : 400;
      return fail(status, error.code, error.action);
    }
    if (error instanceof ToolApiError) return fail(error.status, error.code, error.message);
    if (error instanceof Unauthorized) return fail(401, "unauthorized", error.message);
    if (error instanceof AuthUnavailable) return fail(503, "unavailable", "Authentication is temporarily unavailable.");
    if (error instanceof ProviderError) {
      const status =
        error.code === "conflict"
          ? 409
          : error.code === "forbidden"
            ? 403
            : error.code === "invalid_request"
              ? 400
              : 503;
      return Response.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details?.keepSource === true
              ? {
                  details: {
                    keepSource: true,
                    sourceSandboxId: error.details.sourceSandboxId,
                  },
                }
              : {}),
          },
        },
        { status, headers: { "cache-control": "no-store" } },
      );
    }
    if (error instanceof ProviderRoutingError) return fail(503, error.code, error.message);
    if (error instanceof LaunchError) return fail(400, error.code, error.message);
    if (error instanceof InvitationError)
      return Response.json(
        {
          error: {
            code: error.code,
            message: error.message,
            reason: error.reason,
            ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
          },
        },
        { status: STATUS[error.code], headers: { "cache-control": "no-store" } },
      );
    if (error instanceof VaultError) return fail(STATUS[error.code], error.code, error.message);
    if (error instanceof GoldenError) return fail(GOLDEN_STATUS[error.code], error.code, error.message);
    if (error instanceof EncryptionKeyError) {
      return fail(503, "unavailable", `Credential encryption is not configured on the server (${ENCRYPTION_KEY_ENV}).`);
    }
    return fail(500, "unavailable", "The server could not complete the request.");
  }
}

async function tokenRevokeRoute(request: Request, options: ControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const caller = await authenticatedCaller(request, options);
    const body = await readBody(request);
    const id = required(body, "id");
    if (caller.via !== "supabase") {
      const visible = await listServiceTokens(options.authStore, caller.userId);
      const target = visible.find((token) => token.id === id);
      const members = await options.authStore.memberships(caller.userId);
      const org = caller.orgs[0];
      if (!target || !org || !members.some((member) => member.orgId === org.orgId && member.name === target.orgName))
        return fail(403, "forbidden", "This token is scoped to another org.");
    }
    await revokeServiceToken(options.authStore, {
      userId: caller.userId,
      id,
      now: (options.now ?? (() => new Date()))(),
    });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return fail(403, "forbidden", "Token revocation was refused.");
  }
}

async function tokenCreateRoute(request: Request, options: ControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const caller = await authenticatedCaller(request, options);
    const body = await readBody(request);
    const ref = optional(body, "org") ?? optional(body, "orgName");
    if (body.org !== undefined && body.orgName !== undefined && body.org !== body.orgName)
      return fail(400, "invalid", "Conflicting org selectors.");
    const memberships = await options.authStore.memberships(caller.userId);
    const selected =
      ref === undefined
        ? undefined
        : memberships.find(
            (item) =>
              (item.orgId === ref || item.name.toLowerCase() === ref.toLowerCase()) &&
              caller.orgs.some((scope) => scope.orgId === item.orgId),
          );
    if (ref !== undefined && !selected) return fail(403, "forbidden", "This organization is not in your scope.");
    if (caller.via !== "supabase" && !selected)
      return fail(403, "forbidden", "A scoped token cannot create an unscoped token.");
    const org = selected?.name;
    const created = await createServiceToken(options.authStore, {
      userId: caller.userId,
      ...(org ? { orgName: org } : {}),
      ...(optional(body, "label") ? { label: optional(body, "label")! } : {}),
      now: (options.now ?? (() => new Date()))(),
    });
    return Response.json(
      { id: created.id, label: created.label, orgName: created.orgName, token: created.token },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return fail(401, "unauthorized", "Token creation was refused.");
  }
}

async function tokenListRoute(request: Request, options: ControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const caller = await authenticatedCaller(request, options);
    const tokens = await listServiceTokens(options.authStore, caller.userId);
    const allowed = caller.via !== "supabase" ? new Set(caller.orgs.map((org) => org.orgId)) : null;
    const memberships = allowed ? await options.authStore.memberships(caller.userId) : [];
    const names = new Set(
      memberships.filter((membership) => allowed?.has(membership.orgId)).map((membership) => membership.name),
    );
    return Response.json(
      {
        tokens: tokens
          .filter((token) => !allowed || names.has(token.orgName))
          .map(({ id, label, orgName, createdAt, revokedAt }) => ({ id, label, orgName, createdAt, revokedAt })),
      },
      { headers: { "cache-control": "no-store" } },
    );
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
    return Response.json(
      { accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt },
      { headers: { "cache-control": "no-store" } },
    );
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
    if (
      callback.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(callback.hostname) ||
      !callback.port ||
      callback.username ||
      callback.password ||
      callback.hash ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge) ||
      !/^[A-Za-z0-9._~-]{8,512}$/.test(state)
    )
      throw new Error();
    await sendEmailLink({
      fetch: options.supabase.fetch ?? fetch,
      supabaseUrl: options.supabase.supabaseUrl,
      anonKey: options.supabase.anonKey,
      email,
      redirectTo: callback.toString(),
      challenge,
    });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof Error && error.message.includes("Too many") ? 429 : 400;
    return fail(
      status,
      status === 429 ? "rate_limited" : "invalid",
      status === 429 ? "Try again later." : "Invalid email login request.",
    );
  }
}

async function exchangeRoute(request: Request, options: ControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const body = await readBody(request);
    const code = required(body, "code");
    const verifier = required(body, "verifier");
    if (code.length > 4096 || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
      throw new VaultError("invalid", "Invalid login exchange.");
    const result = options.exchangeNative
      ? await options.exchangeNative(code, verifier)
      : await nativeExchange(options, code, verifier);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ProviderRoutingError) return fail(503, error.code, error.message);
    if (error instanceof LaunchError) return fail(400, error.code, error.message);
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
    if (
      callback.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(callback.hostname) ||
      !callback.port ||
      callback.username ||
      callback.password ||
      callback.hash
    )
      throw new Error();
    const location = supabaseAuthorizeUrl({
      supabaseUrl: options.supabase.supabaseUrl,
      anonKey: options.supabase.anonKey,
      provider: assertProvider(provider),
      redirectTo: callback.toString(),
      challenge,
    });
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
    const refreshed = options.refreshNative ? await options.refreshNative(token) : await nativeRefresh(options, token);
    return Response.json(refreshed, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ProviderRoutingError) return fail(503, error.code, error.message);
    if (error instanceof LaunchError) return fail(400, error.code, error.message);
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
  const next = await refreshSupabaseSession({
    fetch: options.supabase.fetch ?? fetch,
    anonKey: options.supabase.anonKey,
    session,
    now: options.now?.() ?? new Date(),
  });
  return { accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt };
}

async function dispatch(
  route: string,
  caller: Caller,
  body: Record<string, unknown>,
  options: ControlOptions,
): Promise<unknown> {
  if (route === "creds/accounts/usage") {
    if (!options.modelUsage || !options.logs) throw new VaultError("unavailable", "Model usage is not configured.");
    const id = required(body, "id"),
      sandboxId = optional(body, "sandboxId");
    if (!UUID.test(id) || (sandboxId !== undefined && !UUID.test(sandboxId)))
      throw new VaultError("invalid", "Account and sandbox IDs must be UUIDs.");
    const logs = options.logs;
    return options.modelUsage.read(caller, id, sandboxId, (boundSandbox) => logs(caller, boundSandbox));
  }
  if (route === "account/status") return { userId: caller.userId, orgs: caller.orgs, authentication: caller.via };
  if (route.startsWith("github/")) {
    if (!options.githubAccount) throw new VaultError("unavailable", "GitHub account authorization is not configured.");
    return options.githubAccount.command(route.slice("github/".length), caller, body);
  }
  if (route.startsWith("mcp/")) {
    if (route === "mcp/oauth/callback") {
      if (caller.via !== "supabase")
        throw new VaultError("forbidden", "OAuth callbacks require a personal sign-in session.");
      return dispatchMcp(route.slice(4), caller.userId, body, options);
    }
    const org = scopedOrg(caller, optional(body, "org"));
    return dispatchMcp(route.slice(4), caller.userId, { ...body, org }, options);
  }
  if (route === "golden/capabilities") {
    const selected = scopedOrg(caller, optional(body, "org"));
    const member =
      selected === undefined
        ? caller.orgs.length === 1
          ? caller.orgs[0]
          : undefined
        : caller.orgs.find((org) => org.orgId === selected);
    if (!member) throw new VaultError("forbidden", "Name an org in this caller's scope.");
    const backend = optional(body, "provider") ?? "boat";
    if (backend !== "boat" && backend !== "modal") throw new VaultError("invalid", "Provider is boat or modal.");
    if (!options.providerMetadata)
      throw new VaultError("unavailable", "Read-only provider metadata is not configured.");
    return options.providerMetadata({ orgId: member.orgId, provider: backend }, caller);
  }
  const toolName = (
    {
      "golden/capabilities": "golden_capabilities",
      "golden/adopt": "golden_adopt",
      "sandbox/list": "list",
      "sandbox/detail": "status",
      "sandbox/status": "status",
      "sandbox/send": "send",
      "sandbox/stop": "stop",
      "sandbox/wait": "wait",
      "sandbox/exec": "exec",
      "sandbox/steer": "steer",
      "sandbox/interrupt": "interrupt",
    } as Record<string, string>
  )[route];
  if (toolName) {
    if (
      route === "golden/capabilities" &&
      optional(body, "provider") !== undefined &&
      !isSandboxProvider(required(body, "provider"))
    )
      throw new VaultError("invalid", "Provider is boat or modal.");
    if (!options.data || !options.providers) throw new VaultError("unavailable", "Sandbox control is not configured.");
    if (
      route === "golden/capabilities" &&
      optional(body, "org") !== undefined &&
      !caller.orgs.some((member) => member.orgId === scopedOrg(caller, optional(body, "org")))
    )
      throw new VaultError("forbidden", "You are not a member of this org.");
    const scopedCaller = await selectedCaller(options, caller, optional(body, "org"));
    return callSharedTool(
      {
        ...(options.goldenAdoption ? { goldenAdoption: options.goldenAdoption } : {}),
        caller: scopedCaller,
        data: options.data(scopedCaller),
        provider: (target) =>
          options.providers
            ? options.providers.resolve(target, scopedCaller)
            : Promise.reject(new VaultError("unavailable", "Resource providers are not configured.")),
        ...(options.providerMetadata
          ? {
              providerMetadata: (selection) => options.providerMetadata!(selection, scopedCaller),
            }
          : {}),
        launchCredentials: launchCredentials(options.store, options.encryptionKey),
        exposedSecrets: (orgId) =>
          exposedSecrets(options.store, options.encryptionKey, { userId: caller.userId, orgId }),
        now: options.now ?? (() => new Date()),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      toolName,
      body,
    );
  }
  const { store, encryptionKey } = options;
  const userId = caller.userId;
  if (route === "org/provider/status") return orgProviderStatus(store, caller, optional(body, "org"));
  if (route === "org/provider/connect")
    return connectOrgProvider(
      store,
      encryptionKey,
      caller,
      optional(body, "org"),
      required(body, "provider"),
      required(body, "value"),
      options.providerValidator ?? validateOrgProvider,
    );
  if (route === "org/provider/disconnect")
    return disconnectOrgProvider(store, caller, optional(body, "org"), required(body, "provider"));
  const org = scopedOrg(caller, optional(body, "org"));
  switch (route) {
    case "org/create":
      return { org: await createOrg(store, userId, required(body, "name")) };
    case "org/list":
      return {
        orgs: (await listOrgs(store, userId)).filter(
          (item) => caller.via === "supabase" || caller.orgs.some((scope) => scope.orgId === item.id),
        ),
      };
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
    case "creds/accounts/set":
    case "creds/accounts/rename":
    case "creds/accounts/default":
    case "creds/accounts/remove": {
      const action = route.split("/").at(-1) as "set" | "rename" | "default" | "remove";
      const account = await mutateCredentialAccount(store, encryptionKey, userId, {
        action,
        ...(body.expectedVersion === undefined ? {} : { expectedVersion: requiredNumber(body, "expectedVersion") }),
        ...(optional(body, "expiresAt") ? { expiresAt: required(body, "expiresAt") } : {}),
        scope: scope(body),
        ...(org ? { org } : {}),
        ...(body.id !== undefined ? { id: required(body, "id") } : {}),
        ...(body.name !== undefined ? { name: required(body, "name") } : {}),
        ...(optional(body, "kind") ? { kind: parseCredentialKind(required(body, "kind")) } : {}),
        ...(optional(body, "value") ? { value: required(body, "value") } : {}),
      });
      return { account };
    }
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
    case "golden/size-policy": {
      if (!options.data) throw new VaultError("unavailable", "Golden policies are not configured.");
      const data = options.data(caller);
      const name = required(body, "golden");
      const actor = await launchActor(data, caller, name, optional(body, "org"));
      const golden = await goldenForSettings(
        data.goldens,
        actor,
        name,
        optional(body, "provider") as "boat" | "modal" | undefined,
      );
      if (body.policy !== undefined) {
        const policy = parseMachineSizePolicy(
          body.policy,
          golden.config.repos.map((r) => r.dir),
        );
        if (!data.goldens.setSizePolicy) throw new VaultError("unavailable", "Policy writes are unavailable.");
        await data.goldens.setSizePolicy(golden, actor, policy);
        return { goldenId: golden.id, provider: golden.provider, repositories: golden.config.repos, policy };
      }
      return {
        goldenId: golden.id,
        provider: golden.provider,
        repositories: golden.config.repos,
        policy: golden.sizePolicy ?? null,
      };
    }
    case "sandbox/launch-sized-v1":
      if (body.sizePolicyVersion !== 1)
        throw new VaultError("invalid", "The sized launch route requires sizePolicyVersion 1.");
      return launchRoute(options, caller, body);
    case "sandbox/launch":
      return launchRoute(options, caller, body);
    case "launch/resolve":
      throw new VaultError("unavailable", "Client-side credential resolution is retired; use sandbox/launch.");
    case "logs/read":
      return readLogs(
        options,
        await selectedCaller(options, caller, optional(body, "org")),
        required(body, "id"),
        body,
      );
    case "golden/retirement/dry-run":
    case "golden/retirement/reconcile": {
      if (!options.goldenRetirements) throw new VaultError("unavailable", "Snapshot retirement is not configured.");
      const id = required(body, "id");
      if (!UUID.test(id)) throw new VaultError("invalid", "id must be a golden UUID.");
      const selected = await selectedCaller(options, caller, optional(body, "org"));
      return options.goldenRetirements.forCaller(
        caller.userId,
        selected.orgs.map((o) => o.orgId),
        id,
        body.limit === undefined ? 20 : Number(body.limit),
        route.endsWith("reconcile"),
        body.receipts === undefined ? [] : (body.receipts as string[]),
      );
    }
    case "golden/remove": {
      const scopedCaller = await selectedCaller(options, caller, optional(body, "org"));
      const data = options.data?.(scopedCaller);
      if (!data?.removeGolden) throw new VaultError("unavailable", "Golden removal is not configured.");
      return data.removeGolden(required(body, "id"));
    }
    case "golden/visibility": {
      const visibility = required(body, "visibility");
      if (visibility !== "org" && visibility !== "private")
        throw new VaultError("invalid", "Visibility is private or org.");
      const scopedCaller = await selectedCaller(options, caller, optional(body, "org"));
      const data = options.data?.(scopedCaller);
      if (!data?.setGoldenVisibility) throw new VaultError("unavailable", "Visibility management is not configured.");
      await data.setGoldenVisibility(required(body, "id"), visibility);
      return { ok: true };
    }
    case "golden/list":
      return listGoldens(options, await selectedCaller(options, caller, optional(body, "org")));
    case "golden/build/status":
      if (!options.goldenBuilds) throw new VaultError("unavailable", "Durable golden builds are not configured.");
      return options.goldenBuilds.status(
        caller.userId,
        optional(body, "jobId") ?? "",
        optional(body, "idempotencyKey") ? scopedOrg(caller, optional(body, "org")) : undefined,
        optional(body, "idempotencyKey"),
        caller.orgs.map((org) => org.orgId),
      );
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
  id: string;
  name: string;
  provider: GoldenRecord["provider"];
  modal: GoldenRecord["modal"];
  orgId: string;
  visibility: Visibility;
  ownerId: string;
  providerSnapshotId: string | null;
  providerSandboxId: string | null;
  boatSnapshotId: string | null;
  boatSandboxId: string | null;
  repos: number;
  config: { repos: { url: string; branch: string; dir: string }[]; init: string[] };
}

function goldenJson(row: import("@armada/core/server").GoldenRecord): GoldenJson {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    modal: row.modal,
    orgId: row.orgId,
    visibility: row.visibility,
    ownerId: row.ownerId,
    providerSnapshotId: row.providerSnapshotId,
    providerSandboxId: row.providerSandboxId,
    boatSnapshotId: row.provider === "boat" ? row.providerSnapshotId : null,
    boatSandboxId: row.provider === "boat" ? row.providerSandboxId : null,
    repos: row.config.repos.length,
    config: row.config,
  };
}

/**
 * `armada golden create --name`: securely builds a golden from one or more GitHub repositories in a
 * disposable, no-env builder, over the caller's own cached GitHub connection, and persists it only
 * once a fail-closed secret scan and the snapshot both succeed. The caller needs no boat.dev key.
 */
async function createGoldenRoute(options: ControlOptions, caller: Caller, body: Record<string, unknown>) {
  if (!options.goldenBuilds || (!options.providers && !options.providerFor)) {
    throw new VaultError("unavailable", "Secure golden creation is not configured on this server.");
  }
  required(body, "idempotencyKey");
  const org = await resolveOrg(options.store, caller.userId, scopedOrg(caller, optional(body, "org")));
  const visibility: Visibility = requiredBoolean(body, "private", false) ? "private" : "org";
  if (body.provider !== undefined && body.provider !== "boat" && body.provider !== "modal")
    throw new VaultError("invalid", "Provider is boat or modal.");
  if (visibility === "org" && org.role !== "admin")
    throw new VaultError("forbidden", "Only an admin can create an org golden.");
  const targetInput = { orgId: org.id, visibility, provider: (body.provider ?? "boat") as "boat" | "modal" };
  const target = options.goldenTarget
    ? await options.goldenTarget(targetInput, caller)
    : { ...targetInput, modal: null };
  if (target.provider === "modal" && !target.modal)
    throw new ProviderRoutingError("provider_not_configured", "modal", "Modal is not configured.");
  const name = required(body, "name");
  const config = body.config === undefined ? undefined : normalizeGitHubGoldenConfig(parseGoldenConfig(body.config));
  const repos = config ? [] : requiredStringArray(body, "repos");
  const setup = optional(body, "setup");
  const actor: GoldenActor = { userId: caller.userId, orgId: org.id, role: org.role };
  assertGoldenMutation(actor, { orgId: org.id, visibility, ownerId: caller.userId, name });
  if (target.provider === "modal" && !options.providers)
    throw new ProviderRoutingError("provider_not_configured", "modal", "Modal resource routing is not configured.");
  const provider = options.providers
    ? await options.providers.resolve(target, caller)
    : options.providerFor!(
        (
          await resolveBoatKey(options.store, options.encryptionKey, {
            userId: caller.userId,
            orgId: org.id,
            visibility,
          })
        ).key,
        { userId: caller.userId, orgId: org.id },
      );
  return options.goldenBuilds.admit(
    provider,
    actor,
    {
      ...(target.modal ? { modal: target.modal } : {}),
      name,
      visibility,
      repos,
      ...(config === undefined ? {} : { config }),
      ...(setup !== undefined ? { setup } : {}),
    },
    required(body, "idempotencyKey"),
  );
}

/** Rebuild an existing visible golden in place. The row, owner and visibility come from storage, never the body. */
async function updateGoldenRoute(options: ControlOptions, caller: Caller, body: Record<string, unknown>) {
  if (!options.goldenBuilds || (!options.providers && !options.providerFor) || !options.data)
    throw new VaultError("unavailable", "Secure golden creation is not configured on this server.");
  required(body, "idempotencyKey");
  const org = await resolveOrg(options.store, caller.userId, scopedOrg(caller, optional(body, "org")));
  const name = required(body, "name");
  const rows = await options.data(caller).goldens.findByName(org.id, name);
  const existingGolden = selectGolden(rows, body);
  if (!existingGolden) throw new GoldenError("not_found", `No golden named '${name}'.`);
  const actor: GoldenActor = { userId: caller.userId, orgId: org.id, role: org.role };
  assertGoldenMutation(actor, existingGolden);
  if (body.config === undefined) throw new VaultError("invalid", "config is required.");
  const config = normalizeGitHubGoldenConfig(parseGoldenConfig(body.config));
  const provider = await providerForGolden(options, caller, existingGolden);
  return options.goldenBuilds.admit(
    provider,
    actor,
    {
      name: existingGolden.name,
      visibility: existingGolden.visibility,
      repos: [],
      config,
      ...(optional(body, "setup") === undefined ? {} : { setup: optional(body, "setup")! }),
      existingGolden,
    },
    required(body, "idempotencyKey"),
  );
}

async function snapshotGoldenRoute(
  options: ControlOptions,
  caller: Caller,
  body: Record<string, unknown>,
): Promise<{ name: string; snapshot: string }> {
  if (!options.providerFor || !options.data)
    throw new VaultError("unavailable", "Golden snapshots are not configured on this server.");
  const org = await resolveOrg(options.store, caller.userId, scopedOrg(caller, optional(body, "org")));
  const name = required(body, "name");
  const data = options.data(caller);
  const rows = await data.goldens.findByName(org.id, name);
  const golden = selectGolden(rows, body);
  if (!golden) throw new GoldenError("not_found", `No golden named '${name}'.`);
  const actor: GoldenActor = { userId: caller.userId, orgId: org.id, role: org.role };
  assertGoldenMutation(actor, golden);
  const provider = await providerForGolden(options, caller, golden);
  await data.goldens.assertBackendBinding?.(golden, provider);
  const target = (await connectGolden(provider, data.goldens, actor, golden.name)).golden;
  if (!target.providerSandboxId) throw new GoldenError("conflict", `Golden '${target.name}' has no sandbox yet.`);
  await scanGoldenSandbox(provider, target.providerSandboxId);
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
  const golden = selectGolden(rows, body);
  if (!golden) throw new GoldenError("not_found", `No golden named '${name}'.`);
  const actor: GoldenActor = { userId: caller.userId, orgId: org.id, role: org.role };
  assertGoldenMutation(actor, golden);
  const provider = await providerForGolden(options, caller, golden);
  await data.goldens.assertBackendBinding?.(golden, provider);
  const connected = await connectGolden(provider, data.goldens, actor, name);
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
    const page = await target.provider.events({ sandboxId: target.providerSandboxId, ...(cursor ? { cursor } : {}) });
    events.push(...page.events);
    hasMore = page.hasMore;
    const next = page.cursor ?? cursor;
    if (!page.hasMore || !next || next === cursor) {
      cursor = next;
      break;
    }
    cursor = next;
  }
  const info = await target.provider.get(target.providerSandboxId);
  const latest = latestPrompt(events);
  // A live sandbox with no turn is idle, so following has nothing to wait for.
  const outcome = latest
    ? await promptOutcome(target.provider, { sandboxId: target.providerSandboxId, promptId: latest })
    : null;
  return {
    events: dedupe(events).filter((event) => !isPrivateModelEvent(event)),
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
  if (body.visibility !== undefined && body.visibility !== "private" && body.visibility !== "org")
    throw new VaultError("invalid", "Visibility is private or org.");
  if (
    body.connections !== undefined &&
    (!Array.isArray(body.connections) ||
      body.connections.length > 100 ||
      body.connections.some((id) => typeof id !== "string" || !UUID.test(id)))
  )
    throw new VaultError("invalid", "connections must contain at most 100 connection UUIDs.");
  const name = required(body, "golden");
  const repo = body.repo === undefined ? undefined : required(body, "repo");
  const harness = required(body, "harness");
  if (harness !== "claude" && harness !== "codex") throw new VaultError("invalid", "The agent is claude or codex.");
  const data = options.data(caller);
  const actor = await launchActor(data, caller, name, optional(body, "org"));
  const golden = await goldenForLaunch(
    data.goldens,
    actor,
    name,
    optional(body, "provider") as "boat" | "modal" | undefined,
  );
  resolveRepositoryDir(golden, optional(body, "repo"));
  const provider = await providerForGolden(options, caller, golden);
  const result = await launchSandbox(
    provider,
    {
      goldens: data.goldens,
      sandboxes: data.sandboxes,
      ...(options.connections ? { connections: options.connections } : {}),
      credentials: launchCredentials(options.store, options.encryptionKey, {
        store: options.store,
        app: options.github?.app ?? null,
        ...(options.github?.fetch ? { fetch: options.github.fetch } : {}),
        ...(options.github?.now ? { now: options.github.now } : {}),
      }),
    },
    actor,
    {
      ...(body.credentialId !== undefined ? { credentialId: required(body, "credentialId") } : {}),
      golden: name,
      ...(body.size === undefined ? {} : { size: parseMachineSize(body.size) }),
      provider: golden.provider,
      ...(repo === undefined ? {} : { repo }),
      ...(body.visibility === undefined ? {} : { visibility: body.visibility as "private" | "org" }),
      ...(body.connections === undefined ? {} : { connections: body.connections as string[] }),
      ...modelChoice(harness, optional(body, "model"), optional(body, "reasoningEffort")),
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
  if (options.providers) return options.providers.resolve(golden, caller);
  if (golden.provider !== "boat")
    throw new ProviderRoutingError("provider_not_configured", "modal", "Modal is not configured.");
  const key = await resolveBoatKey(options.store, options.encryptionKey, {
    userId: caller.userId,
    orgId: golden.orgId,
    visibility: golden.visibility,
  });
  return (
    options.providerFor?.(key.key, { userId: caller.userId, orgId: golden.orgId }) ??
    Promise.reject(new VaultError("unavailable", "Launching is not configured on this server."))
  );
}

function launchJson(result: LaunchResult) {
  return {
    sandbox: {
      ...result.sandbox,
      boatId: result.sandbox.provider === "boat" ? result.sandbox.providerSandboxId : null,
    },
    golden: {
      ...result.golden,
      boatSnapshotId: result.golden.provider === "boat" ? result.golden.providerSnapshotId : null,
      boatSandboxId: result.golden.provider === "boat" ? result.golden.providerSandboxId : null,
    },
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

function modelChoice(
  harness: "claude" | "codex",
  model: string | undefined,
  reasoningEffort: string | undefined,
): ModelChoice {
  try {
    return resolveModelChoice(harness, { model, reasoningEffort });
  } catch (error) {
    if (error instanceof LaunchError) throw new VaultError("invalid", error.message);
    throw error;
  }
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
  const registry = createSqlMcpRegistry(sql, encryptionKey, {
    catalogAuthentication: catalogAuthenticationFromEnv(
      env,
      encryptionKey,
      env.ARMADA_DASHBOARD_URL,
      env.NODE_ENV === "development",
    ),
  });
  const providerFor = (apiKey: string) => createBoatProvider({ apiKey });
  let modal: ReturnType<typeof createModalIntegration> | undefined;
  const modalIntegration = () =>
    (modal ??= createModalIntegration({
      sql,
      vault: store,
      encryptionKey,
      publicUrl: need("ARMADA_PUBLIC_URL"),
      github: { store, app: githubApp },
    }));
  const providers = providerRegistry({
    vault: store,
    encryptionKey,
    providerFor,
    modalTokensFor: async (target, caller) => (await modalIntegration()).modalTokensFor(target, caller),
    modalProviderFor: async (tokens, binding, context) =>
      (await modalIntegration()).modalProviderFor(tokens, binding, context),
  });
  return {
    invitations: invitationsFromEnv(sql, env),
    mcp: { registry },
    connections: createSqlMcpLaunchPort(sql, registry),
    authStore,
    supabase: { supabaseUrl, anonKey },
    encryptionKey,
    github: { app: githubApp },
    store,
    providerFor,
    modelUsage: createModelUsageApi(sql),
    goldenAdoption: createGoldenAdoption(sql),
    providers,
    data: createSqlData(sql),
    providerMetadata: createProviderMetadata({ sql, vault: store, encryptionKey, providerFor }),
    goldenTarget: async (target, caller) =>
      target.provider === "boat" ? { ...target, modal: null } : (await modalIntegration()).goldenTarget(target, caller),
    goldenBuilds: new GoldenBuildJobs({
      sql,
      encryptionKey,
      service: {
        github: { store, encryptionKey, app: githubApp },
        installationApp: githubInstallationAppFromEnv(env),
      },
      provider: (actor, _visibility, target) => providers.resolve(target, { userId: actor.userId }),
    }),
  };
}

function selectGolden(rows: GoldenRecord[], body: Record<string, unknown>): GoldenRecord | undefined {
  const provider = optional(body, "provider");
  if (provider !== undefined && provider !== "boat" && provider !== "modal")
    throw new VaultError("invalid", "Provider is boat or modal.");
  const selected = rows.filter((row) => provider === undefined || row.provider === provider);
  if (selected.length > 1)
    throw new GoldenError("conflict", "Golden exists on boat and modal. Pass --provider boat or modal.");
  return selected[0];
}

async function dispatchMcp(action: string, userId: string, body: Record<string, unknown>, options: ControlOptions) {
  if (action === "oauth/callback") {
    const callback = options.mcp?.broker?.callback;
    if (!callback || !options.mcp) throw new VaultError("unavailable", "MCP OAuth callback broker is not configured.");
    const result = await callback.call(
      options.mcp.broker,
      userId,
      required(body, "state"),
      required(body, "code"),
      optional(body, "issuer"),
    );
    const connection = await options.mcp.registry.get(userId, result.orgId, result.connectionId);
    return {
      connection: {
        ...connection,
        status: connection.status === "disabled" || result.status === "connected" ? connection.status : result.status,
      },
    };
  }
  const orgId = required(body, "org");
  if (!UUID.test(orgId)) throw new VaultError("invalid", "org must be an organization UUID.");
  // Membership checked even if the registry is not configured.
  const orgs = await listOrgs(options.store, userId);
  if (!orgs.some((o) => o.id === orgId)) throw new VaultError("forbidden", "Organization membership required.");
  if (!options.mcp) throw new VaultError("unavailable", "MCP registry is not configured on this server.");
  const { registry, broker } = options.mcp;
  if (action === "catalog") return { services: await registry.catalog() };
  if (action === "metadata") {
    const id = required(body, "id");
    if (!UUID.test(id)) throw new VaultError("invalid", "id must be a connection UUID.");
    return { connection: await registry.metadata(userId, orgId, id, body) };
  }
  if (action === "list") return { connections: await registry.list(userId, orgId) };
  if (action === "create" || action === "update") {
    if (action === "update" && !UUID.test(required(body, "id")))
      throw new VaultError("invalid", "id must be a connection UUID.");
    return {
      connection: await registry.save(
        userId,
        orgId,
        body as unknown as McpConnectionInput,
        action === "update" ? required(body, "id") : undefined,
      ),
    };
  }
  const id = required(body, "id");
  if (!UUID.test(id)) throw new VaultError("invalid", "id must be a connection UUID.");
  if (action === "sandbox-connections") return { connections: await registry.sandboxConnections(userId, orgId, id) };
  if (action === "set-enabled") {
    if (typeof body.enabled !== "boolean") throw new VaultError("invalid", "enabled must be a boolean.");
    return { connection: await registry.setEnabled(userId, orgId, id, body.enabled) };
  }
  const connection = await registry.get(userId, orgId, id);
  if (action === "delete" || action === "revoke") {
    await registry.revoke(userId, orgId, id, action === "delete");
    return { ok: true };
  }
  if (action === "connect" && connection.scope === "org" && !orgs.some((o) => o.id === orgId && o.role === "admin"))
    throw new VaultError("forbidden", "Only an organization administrator may connect a shared grant.");
  if (action === "connect" && connection.status === "disabled")
    throw new VaultError("conflict", "Enable this MCP connection before connecting.");
  if (connection.transport === "stdio") {
    if (action === "connect") return { connection: await registry.configureStdio(userId, orgId, id) };
    if (action === "status") return { connection };
  }
  if (action === "status" && connection.status === "disabled") return { connection };
  if (action === "connect" || action === "status") {
    if (!broker)
      return {
        connection: {
          ...connection,
          status: "unavailable",
          lastError: "MCP broker is not configured. Ask your administrator to configure the OAuth/gateway service.",
        },
      };
    const result = await broker[action]({ userId, orgId, connectionId: id });
    const current = await registry.get(userId, orgId, id);
    return {
      connection: {
        ...current,
        status: current.status === "disabled" || result.status === "connected" ? current.status : result.status,
      },
      ...("authorizationUrl" in result && result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}),
    };
  }
  throw new VaultError("not_found", "Unknown MCP control action.");
}

async function selectedCaller(options: ControlOptions, caller: Caller, ref: string | undefined): Promise<Caller> {
  if (ref === undefined) return caller;
  const org = await resolveOrg(options.store, caller.userId, scopedOrg(caller, ref));
  return { ...caller, orgs: caller.orgs.filter((item) => item.orgId === org.id) };
}
