import {
  AuthError,
  type AuthStore,
  assertEmail,
  assertEmailCode,
  assertProvider,
  BodyTooLargeError,
  createServiceToken,
  createSqlAuthStore,
  exchangeSupabaseCode,
  listServiceTokens,
  readBoundedText,
  refreshSupabaseSession,
  revokeServiceToken,
  type Session,
  sendEmailLink,
  supabaseAuthorizeUrl,
  verifyEmailCode,
} from "@armada/auth";
import type { Harness } from "@armada/core";
import {
  API_FAILURE_STATUS,
  CLAUDE_ENDPOINT_ENV,
  CODEX_ENDPOINT_ENV,
  dedupeEvents,
  GitHubHydrationError,
  goldenCompatibilityIds,
  goldenForSettings,
  goldenResponse,
  isHarness,
  isModelConnectionTestResult,
  MAX_SANDBOX_EXTENSION_TTL_SECONDS,
  parseMachineSize,
  parseMachineSizePolicy,
  providerRateLimitDetails,
  providerRateLimitMessage,
  VERSION,
} from "@armada/core";
import {
  type ApplicationVault,
  addMember,
  assertGoldenMutation,
  connectGolden,
  createApplicationVault,
  createGoldenAdoption,
  createOrg,
  createRoutineService,
  createSkillCatalog,
  createSkillDefaultsService,
  createSqlMcpLaunchPort,
  createSqlMcpRegistry,
  createSqlVaultStore,
  createTemplateService,
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
  listConnectionModels,
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
  type RoutineService,
  removeCredential,
  removeMember,
  resolveBoatKey,
  resolveModelChoice,
  resolveOrg,
  resolveRepositoryDir,
  resolveSkillpackCredential,
  type SkillDefaultsService,
  sandboxActivity,
  scanGoldenSandbox,
  setCredential,
  setMemberRole,
  snapshotGolden,
  type TemplateService,
  VaultError,
  type VaultErrorCode,
  type VaultStore,
  type Visibility,
} from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { GatewayError } from "../../mcp-gateway/src/network.ts";
import { apiFailureCode } from "./api-failure.ts";
import { AuthUnavailable, authenticateCaller, type Caller, type SupabaseProject } from "./caller.ts";
import { databasePoolMax } from "./config.ts";
import { type CredentialBindingRecovery, createCredentialBindingRecovery } from "./credential-binding-recovery.ts";
import { createSqlData, type DataSource, type ScopedData } from "./data.ts";
import type { GitHubAccountApi } from "./github-account.ts";
import { providerRegistry } from "./http.ts";
import { InvitationError, type Invitations, invitationsFromEnv } from "./invitations.ts";
import { exposedSecrets, launchCredentials } from "./launch-credentials.ts";
import { launchOptions, launchProviderOptions } from "./launch-options.ts";
import { catalogAuthenticationFromEnv } from "./mcp-catalog-client.ts";
import { createMcpLifecycle } from "./mcp-lifecycle.ts";
import { createHistoricalSandboxProviderResolver } from "./mcp-sandbox-provider.ts";
import { createModalIntegration } from "./modal-integration.ts";
import { createModelAuthOwnership, type ModelAuthOwnership, modelAuthCapabilities } from "./model-auth.ts";
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
import { RequestTiming, withRequestTiming } from "./request-timing.ts";
import type { RuntimeCheckpoint } from "./runtime-checkpoint.ts";
import type { RuntimeFollowup } from "./runtime-followup.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";
import type { RuntimeMcp } from "./runtime-mcp.ts";
import type { RuntimeResume } from "./runtime-resume.ts";
import { type createSandboxArmadaAccess, parseSandboxArmadaAccess } from "./sandbox-armada-access.ts";
import { bunSql } from "./sql.ts";
import { createSubscriptionMigration } from "./subscription-migration.ts";
import { callSharedTool, ToolApiError } from "./tool-api.ts";

export const CONTROL_PREFIX = "/api/v1/";
const MAX_BODY_BYTES = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ControlOptions {
  dockerLaunch?: import("./docker-normal-launch.ts").DockerNormalLaunch;
  /** Listener-local keepalive for the bounded synchronous Docker launch pipeline. */
  configureDockerLaunchRequest?: (request: Request) => void;
  dockerControls?: import("./docker-sandbox-controls.ts").DockerSandboxControls;
  /** Trusted installed-route discovery, never taken from request JSON. */
  docker?: {
    hosts?: boolean;
    placement?: boolean;
    normalApi?: boolean;
    normalLaunch?: boolean;
    normalSend?: boolean;
    normalResume?: boolean;
  };
  runtimeMcp?: RuntimeMcp;
  runtimeGitHub?: RuntimeGitHub;
  runtimeResume?: RuntimeResume;
  runtimeCheckpoint?: RuntimeCheckpoint;
  runtimeSend?: RuntimeFollowup;
  modalRuntimeHostFor?: (target: import("@armada/core").ProviderTarget, caller: Caller) => Promise<Provider>;
  modalRuntimeLaunch?: NonNullable<LaunchOptions["runtime"]>;
  boatRuntimeLaunch?: NonNullable<LaunchOptions["boatRuntime"]>;
  runtimeHostFor?: (apiKey: string) => Provider;
  skillCatalog?: ReturnType<typeof createSkillCatalog>;
  /** Per-request diagnostics; supplied by the HTTP handler, never request JSON. */
  timing?: RequestTiming;
  storedProviderFor?: (target: ProviderTarget, caller: { userId: string }) => Promise<Provider>;
  sandboxArmadaAccess?: ReturnType<typeof createSandboxArmadaAccess>;
  templates?: TemplateService;
  skillDefaults?: SkillDefaultsService;
  routines?: RoutineService;
  applicationVault?: ApplicationVault;
  /** Trusted dashboard origin, from ARMADA_PUBLIC_URL; never request Host headers. */
  publicUrl?: string;
  modelAuth?: ModelAuthOwnership;
  credentialBindingRecovery?: CredentialBindingRecovery;
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

export type ConfiguredControlOptions = ControlOptions & { credentialBindingRecovery: CredentialBindingRecovery };

const STATUS: Record<VaultErrorCode, number> = {
  credential_busy: 409,
  credential_binding_required: 409,
  credential_binding_unsafe: 409,
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  missing_credential: 404,
  conflict: 409,
  unavailable: 503,
  credential_refused: 422,
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
      : fail(503, "dependency_unavailable", "GitHub account authorization is not configured.");
  }
  if (route === "auth/methods") return authMethodsRoute(request, options);
  if (route === "auth/authorize") return authorizeRoute(request, options);
  if (route === "auth/exchange") return exchangeRoute(request, options);
  if (route === "auth/email/start") return emailStartRoute(request, options);
  if (route === "auth/email/verify") return emailVerifyRoute(request, options);
  if (route === "token/list") return tokenListRoute(request, options);
  if (route === "token/create") return tokenCreateRoute(request, options);
  if (route === "token/revoke") return tokenRevokeRoute(request, options);
  if (route === "auth/refresh") return refreshRoute(request, options);
  const deletion = /^sandboxes\/([0-9a-f-]+)$/i.exec(route);
  if (deletion ? request.method !== "DELETE" : request.method !== "POST")
    return fail(405, "invalid", deletion ? "Use DELETE." : "Use POST.");
  const timing = new RequestTiming();
  options = { ...options, timing };
  try {
    const caller = await timing.measure("auth", () => authenticatedCaller(request, options));
    if (
      (route === "skillpack/catalog" ||
        route === "skillpack/versions" ||
        route.startsWith("skills/defaults/") ||
        route.startsWith("templates/") ||
        route.startsWith("routines/") ||
        route.startsWith("variables/") ||
        route.startsWith("secrets/")) &&
      url.search
    )
      throw new VaultError("invalid", "Parameters must be in the request body.");
    const body = deletion
      ? { id: deletion[1], org: url.searchParams.get("org") ?? undefined }
      : route === "skillpack/catalog" ||
          route === "skillpack/versions" ||
          route.startsWith("skills/defaults/") ||
          route.startsWith("templates/") ||
          route.startsWith("routines/") ||
          route.startsWith("variables/") ||
          route.startsWith("secrets/")
        ? await readVaultBody(request)
        : await readBody(request);
    if (
      ((route === "sandbox/launch" && body.provider === "docker") || route === "templates/launch") &&
      options.dockerLaunch
    )
      options.configureDockerLaunchRequest?.(request);
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
    } else
      result = await timing.measure("dispatch", () =>
        withRequestTiming(timing, () => dispatch(deletion ? "sandbox/delete" : route, caller, body, options)),
      );
    if (result === undefined) return fail(404, "unknown_route", "Unknown route.");
    return Response.json(result, {
      status:
        (route === "golden/create" || route === "golden/update") &&
        typeof result === "object" &&
        result !== null &&
        "jobId" in result
          ? 202
          : 200,
      headers: { "cache-control": "no-store", "server-timing": timing.header() },
    });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    const failureCode = apiFailureCode(error);
    if (failureCode)
      return Response.json(
        {
          error: {
            code: failureCode,
            message: error instanceof Error ? error.message : failureCode,
            ...(error instanceof GitHubHydrationError ? { details: error.details } : {}),
            ...(error instanceof ProviderError && error.details?.keepSource === true
              ? { details: { keepSource: true, sourceSandboxId: error.details.sourceSandboxId } }
              : {}),
          },
        },
        { status: API_FAILURE_STATUS[failureCode], headers: { "cache-control": "no-store" } },
      );
    if (error instanceof GatewayError) {
      const status =
        error.code === "denied" ? 403 : error.code === "busy" ? 409 : error.code === "upstream" ? 502 : 400;
      return fail(status, error.code, error.action);
    }
    if (error instanceof ToolApiError) return fail(error.status, error.code, error.message, error.details);
    if (error instanceof Unauthorized) return fail(401, "unauthorized", error.message);
    if (error instanceof AuthUnavailable)
      return fail(503, "dependency_unavailable", "Authentication is temporarily unavailable.");
    if (error instanceof ProviderError) {
      const limit =
        error.provider === "boat" && error.code === "rate_limited" && error.status === 429
          ? providerRateLimitDetails({ ...error.details, provider: "boat", retryAfterSeconds: error.retryAfterSeconds })
          : undefined;
      const status =
        error.code === "rate_limited"
          ? 429
          : error.code === "payment_required"
            ? 402
            : error.code === "conflict"
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
            message: limit ? providerRateLimitMessage(limit) : error.message,
            ...(limit
              ? { details: limit }
              : error.details?.keepSource === true
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
    if (error instanceof LaunchError)
      return fail(
        400,
        error.code,
        error.message,
        error.reason
          ? { reason: error.reason, action: error.action, ...(error.stage ? { stage: error.stage } : {}) }
          : undefined,
      );
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
    if (error instanceof VaultError) {
      if (error.code === "credential_busy")
        return Response.json(
          { error: { code: "conflict", reason: "credential_busy", message: error.message } },
          { status: 409, headers: { "cache-control": "no-store" } },
        );
      return fail(STATUS[error.code], error.code, error.message);
    }
    if (error instanceof GoldenError) return fail(GOLDEN_STATUS[error.code], error.code, error.message);
    if (error instanceof EncryptionKeyError) {
      return fail(
        503,
        "dependency_unavailable",
        `Credential encryption is not configured on the server (${ENCRYPTION_KEY_ENV}).`,
      );
    }
    return fail(500, "internal", "The server could not complete the request.");
  }
}

/** Only store I/O is a dependency failure; policy/validation errors stay outside this boundary. */
function tokenRouteStore(store: AuthStore): AuthStore {
  const dependency = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch {
      throw new AuthUnavailable("Token store unavailable.");
    }
  };
  return {
    ...store,
    memberships: (...args) => dependency(() => store.memberships(...args)),
    listServiceTokens: (...args) => dependency(() => store.listServiceTokens(...args)),
    insertToken: (...args) => dependency(() => store.insertToken(...args)),
    revokeToken: (...args) => dependency(() => store.revokeToken(...args)),
  };
}

function tokenRouteFailure(error: unknown, revoking = false): Response {
  if (error instanceof AuthUnavailable)
    return fail(503, "dependency_unavailable", "Token service is temporarily unavailable.");
  if (error instanceof Unauthorized) return fail(401, "unauthorized", "Run armada login.");
  if (error instanceof VaultError) return fail(STATUS[error.code], error.code, error.message);
  if (error instanceof AuthError)
    return revoking
      ? fail(403, "forbidden", "Token revocation was refused.")
      : fail(400, "invalid", "Invalid token request.");
  return fail(500, "internal", "The server could not complete the request.");
}

async function tokenRevokeRoute(request: Request, options: ControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const caller = await authenticatedCaller(request, options);
    const store = tokenRouteStore(options.authStore);
    const body = await readBody(request);
    const id = required(body, "id");
    if (!UUID.test(id)) throw new VaultError("invalid", "id must be a token UUID.");
    if (caller.via !== "supabase") {
      const visible = await listServiceTokens(store, caller.userId);
      const target = visible.find((token) => token.id === id);
      const members = await store.memberships(caller.userId);
      const org = caller.orgs[0];
      if (!target || !org || !members.some((member) => member.orgId === org.orgId && member.name === target.orgName))
        return fail(403, "forbidden", "This token is scoped to another org.");
    }
    await revokeServiceToken(store, {
      userId: caller.userId,
      id,
      now: (options.now ?? (() => new Date()))(),
    });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    return tokenRouteFailure(error, true);
  }
}

async function tokenCreateRoute(request: Request, options: ControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const caller = await authenticatedCaller(request, options);
    const store = tokenRouteStore(options.authStore);
    const body = await readBody(request);
    const ref = optional(body, "org") ?? optional(body, "orgName");
    if (body.org !== undefined && body.orgName !== undefined && body.org !== body.orgName)
      return fail(400, "invalid", "Conflicting org selectors.");
    const memberships = await store.memberships(caller.userId);
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
    const created = await createServiceToken(store, {
      userId: caller.userId,
      ...(org ? { orgName: org } : {}),
      ...(optional(body, "label") ? { label: optional(body, "label")! } : {}),
      now: (options.now ?? (() => new Date()))(),
    });
    return Response.json(
      { id: created.id, label: created.label, orgName: created.orgName, token: created.token },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    return tokenRouteFailure(error);
  }
}

async function tokenListRoute(request: Request, options: ControlOptions): Promise<Response> {
  if (request.method !== "POST") return fail(405, "invalid", "Use POST.");
  try {
    const caller = await authenticatedCaller(request, options);
    const store = tokenRouteStore(options.authStore);
    const tokens = await listServiceTokens(store, caller.userId);
    const allowed = caller.via !== "supabase" ? new Set(caller.orgs.map((org) => org.orgId)) : null;
    const memberships = allowed ? await store.memberships(caller.userId) : [];
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
  } catch (error) {
    return tokenRouteFailure(error);
  }
}

/** Expose only supported sign-in methods, never upstream configuration. */
async function authMethodsRoute(request: Request, options: ControlOptions): Promise<Response> {
  if (request.method !== "GET") return fail(405, "invalid", "Use GET.");
  try {
    const response = await (options.supabase.fetch ?? fetch)(
      new URL("/auth/v1/settings", options.supabase.supabaseUrl),
      { headers: { apikey: options.supabase.anonKey }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error();
    const settings = (await response.json()) as { external?: Record<string, unknown> };
    if (!settings.external || typeof settings.external !== "object") throw new Error();
    const methods = ["email", "github", "google"].filter((method) => settings.external?.[method] === true);
    return Response.json({ methods }, { headers: { "cache-control": "no-store" } });
  } catch {
    return fail(503, "unavailable", "Sign-in methods are unavailable; try again later.");
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
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
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
    if (body.cli_email_link !== undefined && typeof body.cli_email_link !== "boolean") throw new Error();
    const cliEmailLink = body.cli_email_link === true;
    if (
      callback.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(callback.hostname) ||
      !callback.port ||
      callback.username ||
      callback.password ||
      callback.hash ||
      (cliEmailLink && (callback.pathname !== "/callback" || callback.search)) ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge) ||
      !/^[A-Za-z0-9._~-]{8,512}$/.test(state)
    )
      throw new Error();
    if (cliEmailLink) callback.searchParams.set("state", state);
    await sendEmailLink({
      fetch: options.supabase.fetch ?? fetch,
      supabaseUrl: options.supabase.supabaseUrl,
      anonKey: options.supabase.anonKey,
      email,
      // Existing clients (including iOS) remain numeric-code-only unless explicitly opted in.
      redirectTo: cliEmailLink
        ? callback.toString()
        : new URL("/login?flow=code", options.publicUrl ?? "https://armada.thevibecompany.co").toString(),
      challenge,
    });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
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
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    if (error instanceof ProviderRoutingError) return fail(503, error.code, error.message);
    if (error instanceof LaunchError)
      return fail(
        400,
        error.code,
        error.message,
        error.reason ? { reason: error.reason, action: error.action } : undefined,
      );
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
    if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
    if (error instanceof ProviderRoutingError) return fail(503, error.code, error.message);
    if (error instanceof LaunchError)
      return fail(
        400,
        error.code,
        error.message,
        error.reason ? { reason: error.reason, action: error.action } : undefined,
      );
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
  if (route.startsWith("skills/defaults/")) {
    if (!options.skillDefaults) throw new VaultError("unavailable", "Skill defaults unavailable.");
    return options.skillDefaults.command(caller, route.slice("skills/defaults/".length), body);
  }
  if (route.startsWith("routines/")) {
    if (!options.routines) throw new VaultError("unavailable", "Routines unavailable.");
    return options.routines.command(caller, route.slice(9), body);
  }
  if (route.startsWith("templates/")) {
    if (!options.templates) throw new VaultError("unavailable", "Templates unavailable.");
    return options.templates.command(caller, route.slice(10), body, templateRuntime(options, caller));
  }

  if (route.startsWith("variables/") || route.startsWith("secrets/")) {
    if (!options.applicationVault) throw new VaultError("unavailable", "Application vault unavailable.");
    if (!/^(variables|secrets)\/[a-z]+$/.test(route))
      throw new VaultError("invalid", "Invalid application vault request.");
    const [resource, operation] = route.split("/");
    return options.applicationVault.command(
      caller,
      resource === "variables" ? "variable" : "secret",
      operation as Parameters<ApplicationVault["command"]>[2],
      body,
    );
  }
  if (route === "creds/accounts/auth-capabilities")
    return { ...modelAuthCapabilities, nativeSubscriptionParallelSandboxes: Boolean(options.modelAuth?.broker) };
  if (route === "launch/options")
    return {
      ...launchOptions,
      providers: launchProviderOptions(options.docker),
      modalRuntime: {
        version: 1,
        enabled: Boolean(options.modalRuntimeLaunch),
        followupVersion: options.runtimeSend ? 1 : 0,
        resumeVersion: options.runtimeResume && options.modalRuntimeLaunch ? 1 : 0,
        mcpVersion: options.runtimeMcp ? 2 : 0,
        skillsVersion: options.modalRuntimeLaunch ? 1 : 0,
        usageVersion: options.modalRuntimeLaunch ? 1 : 0,
        variablesVersion: options.templates && options.modalRuntimeLaunch && options.modalRuntimeHostFor ? 1 : 0,
      },
      boatRuntime: {
        defaultPath: options.launch?.boatRuntimeDefault ? "runtime" : "native",
        version: 1,
        diagnosticsVersion: 1,
        followupVersion: options.runtimeSend ? 1 : 0,
        checkpointVersion: options.runtimeCheckpoint ? 1 : 0,
        resumeVersion: options.runtimeResume ? 1 : 0,
        githubVersion: options.runtimeGitHub ? 1 : 0,
        mcpVersion: options.runtimeMcp ? 2 : 0,
        skillsVersion: options.boatRuntimeLaunch ? 1 : 0,
        workspaceVersion: options.boatRuntimeLaunch ? 1 : 0,
        controlsVersion: options.runtimeHostFor ? 1 : 0,
        enabled: Boolean(options.boatRuntimeLaunch && options.runtimeHostFor),
      },
    } satisfies import("@armada/core").LaunchOptionsResponse;
  if (route === "creds/accounts/usage") {
    if (!options.modelUsage || !options.logs) throw new VaultError("unavailable", "Model usage is not configured.");
    const id = required(body, "id"),
      sandboxId = optional(body, "sandboxId");
    if (!UUID.test(id) || (sandboxId !== undefined && !UUID.test(sandboxId)))
      throw new VaultError("invalid", "Account and sandbox IDs must be UUIDs.");
    const logs = options.logs;
    return options.modelUsage.read(caller, id, sandboxId, (boundSandbox) => logs(caller, boundSandbox));
  }
  if (route === "account/status")
    return { userId: caller.userId, orgs: caller.orgs, authentication: caller.via, version: VERSION };
  if (route.startsWith("github/") && route !== "github/refresh" && route !== "github/runtime-status") {
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
    if (route === "mcp/sandbox-connections") {
      const sandbox = await options.data?.(caller).sandboxes.get(required(body, "id"));
      if (!sandbox || sandbox.orgId !== org) throw new VaultError("not_found", "No such sandbox.");
    }
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
    if (!isSandboxProvider(backend)) throw new VaultError("invalid", "Provider is boat or modal.");
    if (!options.providerMetadata)
      throw new VaultError("unavailable", "Read-only provider metadata is not configured.");
    return options.providerMetadata({ orgId: member.orgId, provider: backend }, caller);
  }
  if (route === "sandbox/test-model-connection") {
    if (Object.keys(body).some((key) => !["id", "model", "org"].includes(key)))
      throw new VaultError("invalid", "Connection checks accept only id, model and org.");
    const id = required(body, "id");
    if (!UUID.test(id)) throw new VaultError("invalid", "id must be an Armada sandbox UUID.");
    if (!options.data || !options.providers) throw new VaultError("unavailable", "Sandbox control is not configured.");
    const scoped = await selectedCaller(options, caller, optional(body, "org"));
    const data = options.data(scoped);
    const found = await data.sandboxes.get(id);
    if (!found) throw new VaultError("not_found", "Sandbox not found.");
    if (found.ownerId !== caller.userId)
      throw new VaultError("forbidden", "Only the sandbox owner may test its model connection.");
    if (
      found.provider !== "modal" ||
      !["ready", "running"].includes(found.status) ||
      found.stopRequestedAt ||
      !found.credentialId ||
      !found.credentialVersion
    )
      throw new VaultError(
        "conflict",
        "Connection checks require a running, bound Modal sandbox; no resume is performed.",
      );
    const harness = found.harness;
    if (harness !== "claude" && harness !== "codex")
      throw new VaultError("invalid", "Connection checks currently support Claude and Codex only.");
    const model = resolveModelChoice(harness, { model: required(body, "model") }).model;
    const credentials = launchCredentials(options.store, options.encryptionKey, undefined, options.modelAuth);
    const actor: GoldenActor = { userId: found.ownerId, orgId: found.orgId, role: "member" };
    const bound = await credentials.resolve(actor, found.harness, found.credentialId, found.credentialVersion);
    if (!bound.env[found.harness === "codex" ? CODEX_ENDPOINT_ENV : CLAUDE_ENDPOINT_ENV])
      throw new VaultError("invalid", "This check supports custom endpoint connections only.");
    await credentials.assertTurn?.(actor, found.id, false);
    const provider = await options.providers.resolve(found, scoped);
    if (!provider.testModelConnection)
      throw new VaultError("unavailable", "Runtime connection checks are unavailable.");
    const machine = await provider.get(found.providerSandboxId);
    if (!["ready", "running"].includes(machine.state))
      throw new VaultError("conflict", "Sandbox must already be running.");
    const test = await sandboxActivity(
      data.sandboxes,
      found,
      {},
      async () => {
        const result = await provider.testModelConnection!({
          sandboxId: found.providerSandboxId,
          harness,
          model,
        });
        if (!isModelConnectionTestResult(result))
          throw new VaultError("unavailable", "Invalid connection-test receipt.");
        return { result, patch: {} };
      },
      { deadlineMs: 30000, failurePatch: () => ({}) },
    );
    return { id: found.id, test };
  }
  const toolName = (
    {
      "golden/capabilities": "golden_capabilities",
      "golden/adopt": "golden_adopt",
      "github/refresh": "github_refresh",
      "github/runtime-status": "runtime_github_status",
      "sandbox/list": "list",
      "sandbox/detail": "status",
      "sandbox/status": "status",
      "sandbox/recovery": "work_recovery",
      "sandbox/advice": "resource_advice",
      "sandbox/send": "send",
      "sandbox/resume": "resume",
      "sandbox/checkpoint-runtime-v1": "runtime_checkpoint",
      "sandbox/resume-runtime-v1": "runtime_resume",
      "sandbox/report": "report",
      "sandbox/stop": "stop",
      "sandbox/extend": "extend",
      "sandbox/delete": "delete",
      "sandbox/wait": "wait",
      "sandbox/exec": "exec",
      "sandbox/steer": "steer",
      "sandbox/interrupt": "interrupt",
    } as Record<string, string>
  )[route];
  if (toolName) {
    if (
      route === "sandbox/extend" &&
      Number.isSafeInteger(body.ttl_seconds) &&
      Number(body.ttl_seconds) > MAX_SANDBOX_EXTENSION_TTL_SECONDS
    )
      throw new ToolApiError("extension_maximum", "Requested lifetime exceeds the server maximum.");
    if (
      route === "sandbox/extend" &&
      (!Number.isSafeInteger(body.ttl_seconds) ||
        Number(body.ttl_seconds) < 1 ||
        Number(body.ttl_seconds) > MAX_SANDBOX_EXTENSION_TTL_SECONDS)
    )
      throw new VaultError(
        "invalid",
        "ttl_seconds must be a positive whole number of seconds within the server maximum.",
      );
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
        ...(options.dockerControls ? { dockerControls: options.dockerControls } : {}),
        ...(options.runtimeSend ? { runtimeSend: options.runtimeSend } : {}),
        ...(options.runtimeCheckpoint ? { runtimeCheckpoint: options.runtimeCheckpoint } : {}),
        ...(options.runtimeResume ? { runtimeResume: options.runtimeResume } : {}),
        ...(options.runtimeGitHub ? { runtimeGitHub: options.runtimeGitHub } : {}),
        ...(options.connections ? { connections: options.connections } : {}),
        data: options.data(scopedCaller),
        measure: (phase, work) => measured(options, phase, work),
        ...(options.storedProviderFor
          ? {
              storedProvider: (target: ProviderTarget) =>
                measured(options, "stored_provider", () => options.storedProviderFor!(target, scopedCaller)),
            }
          : {}),
        provider: (target) =>
          measured(options, "provider", () =>
            options.providers
              ? options.providers.resolve(target, scopedCaller)
              : Promise.reject(new VaultError("unavailable", "Resource providers are not configured.")),
          ),
        deletionProvider: (sandbox) =>
          options.providers
            ? options.providers.resolve(sandbox, { userId: sandbox.ownerId })
            : Promise.reject(new VaultError("unavailable", "Resource providers are not configured.")),
        ...(options.providerMetadata
          ? {
              providerMetadata: (selection) => options.providerMetadata!(selection, scopedCaller),
            }
          : {}),
        launchCredentials: launchCredentials(
          options.store,
          options.encryptionKey,
          options.github ? { ...options.github, store: options.store } : undefined,
          options.modelAuth,
        ),
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
    case "skillpack/catalog":
    case "skillpack/versions": {
      const versions = route === "skillpack/versions";
      const allowed = versions ? ["org", "source", "reference"] : ["org", "source", "offset"];
      if (Object.keys(body).some((key) => !allowed.includes(key)))
        throw new VaultError("invalid", "Invalid skill catalog request.");
      if (body.source !== "public" && body.source !== "private")
        throw new VaultError("invalid", "Choose the public catalog or private workspace.");
      if (
        body.offset !== undefined &&
        (typeof body.offset !== "number" || !Number.isInteger(body.offset) || body.offset < 0 || body.offset > 10000)
      )
        throw new VaultError("invalid", "Invalid catalog offset.");
      const member = await resolveOrg(store, userId, org);
      // Resolve exactly the launching user's credential policy; never expose the
      // PAT or let a caller select an alternate registry or workspace header.
      const credential =
        body.source === "private"
          ? await resolveSkillpackCredential(store, encryptionKey, { userId, orgId: member.id })
          : null;
      const catalog = options.skillCatalog ?? createSkillCatalog();
      const result = versions
        ? await catalog.versions({ source: body.source, reference: required(body, "reference") }, credential?.key)
        : await catalog.list(
            { source: body.source, ...(body.offset === undefined ? {} : { offset: body.offset as number }) },
            credential?.key,
          );
      // Membership may have changed during the bounded upstream request.
      await resolveOrg(store, userId, member.id);
      return result;
    }
    case "skillpack/connection": {
      // Reuse vault visibility, including live membership and token org scoping.
      const credentials = await listCredentials(store, userId, org);
      return {
        authorization: { available: false, reason: "delegated_key_flow_unavailable" },
        user: credentials.user.filter((credential) => credential.kind === "skillpack"),
        orgs: credentials.orgs.map((entry) => ({
          ...entry,
          credentials: entry.credentials.filter((credential) => credential.kind === "skillpack"),
        })),
      };
    }
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
    case "creds/accounts/models": {
      // The declared models of visible custom connections (#1483): decrypted here, never the key or the address.
      const member = await resolveOrg(store, userId, org);
      return { connections: await listConnectionModels(store, encryptionKey, { userId, orgId: member.id }) };
    }
    case "creds/rm":
      await removeCredential(store, userId, {
        scope: scope(body),
        org,
        kind: parseCredentialKind(required(body, "kind")),
      });
      return { ok: true };
    case "sandbox/bind-credential":
      if (!options.credentialBindingRecovery)
        throw new VaultError("unavailable", "Binding recovery is not configured.");
      return options.credentialBindingRecovery(caller, {
        id: required(body, "id"),
        credentialId: required(body, "credentialId"),
        // An org name or ID, resolved against fresh memberships like every other sandbox route.
        ...(org ? { org: (await resolveOrg(store, userId, org)).id } : {}),
      });
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
    case "sandbox/mcp-preflight-v1":
      if (body.runtimeVersion !== 1 || !options.runtimeMcp)
        throw new VaultError("unavailable", "Runtime MCP v1 is unavailable.");
      return options.runtimeMcp.preflight(caller, {
        org: required(body, "org"),
        connections: body.connections as string[],
      });
    case "sandbox/github-preflight-v1":
      if (body.runtimeVersion !== 1 || !options.runtimeGitHub)
        throw new VaultError("unavailable", "Runtime GitHub v1 is unavailable.");
      return options.runtimeGitHub.preflight(caller, {
        org: required(body, "org"),
        golden: required(body, "golden"),
        repository: required(body, "repository"),
      });
    case "sandbox/launch-modal-runtime-v1":
      if (
        body.runtimeVersion !== 1 ||
        body.runtimeTransport !== "dialout" ||
        body.provider !== "modal" ||
        body.harness !== "codex" ||
        body.boatRuntime !== undefined ||
        body.armadaAccess ||
        (body.connections !== undefined && !Array.isArray(body.connections)) ||
        (body.helperCapabilities !== undefined &&
          (!Array.isArray(body.helperCapabilities) || body.helperCapabilities.length))
      )
        throw new VaultError("invalid", "Modal runtime v1 requires explicit Codex launch; helpers are unavailable.");
      if (!options.modalRuntimeLaunch || !options.modalRuntimeHostFor)
        throw new VaultError("unavailable", "Modal runtime staging opt-in is disabled.");
      required(body, "prompt");
      if (body.id !== undefined) {
        const standard = [
          "org",
          "id",
          "revision",
          "requestKey",
          "prompt",
          "ttlSeconds",
          "size",
          "repo",
          "skills",
          "skipSkillDefaults",
        ];
        if (
          Object.keys(body).some(
            (key) => ![...standard, "runtimeVersion", "runtimeTransport", "provider", "harness"].includes(key),
          ) ||
          typeof body.id !== "string" ||
          !UUID.test(body.id) ||
          typeof body.org !== "string" ||
          !UUID.test(body.org) ||
          !Number.isSafeInteger(body.revision) ||
          Number(body.revision) < 1
        )
          throw new VaultError(
            "invalid",
            "Modal runtime templates require a pinned revision, organization UUID and unambiguous template fields.",
          );
        if (!options.templates) throw new VaultError("unavailable", "Templates unavailable.");
        const base = templateRuntime(options, caller);
        if (!base) throw new VaultError("unavailable", "Template launching unavailable.");
        const input = Object.fromEntries(
          standard.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]),
        );
        return options.templates.command(caller, "launch", input, {
          validateDefinition: (definition) => {
            if (definition.provider !== "modal" || definition.harness !== "codex" || definition.secrets?.length)
              throw new VaultError(
                "invalid",
                "Modal runtime templates require Modal Codex without application-secret bindings.",
              );
          },
          stores: {
            goldens: base.stores.goldens,
            sandboxes: base.stores.sandboxes,
            credentials: launchCredentials(options.store, options.encryptionKey, undefined, options.modelAuth),
            ...(options.runtimeMcp ? { connections: options.runtimeMcp.connections } : {}),
          },
          provider: (golden) => options.modalRuntimeHostFor!({ ...golden, runtimeTransport: "dialout" }, caller),
          options: { ...base.options, runtime: options.modalRuntimeLaunch },
        });
      }
      return launchRoute(options, caller, body, "modal");
    case "sandbox/launch-runtime-v1":
      if (
        body.runtimeVersion !== 1 ||
        body.boatRuntime !== true ||
        (body.harness !== "codex" && body.harness !== "claude") ||
        (body.provider !== undefined && body.provider !== "boat") ||
        body.armadaAccess ||
        (body.helperCapabilities !== undefined &&
          (!Array.isArray(body.helperCapabilities) || body.helperCapabilities.length))
      )
        throw new VaultError("invalid", "Runtime v1 requires explicit Boat Codex or Claude snapshot launch.");
      if (!options.boatRuntimeLaunch || !options.runtimeHostFor)
        throw new VaultError("unavailable", "Experimental Boat runtime launch is not configured.");
      required(body, "prompt");
      return launchRoute(options, caller, body, true);
    case "sandbox/launch-access-v1":
      if (body.armadaAccessVersion !== 1 || !parseSandboxArmadaAccess(body.armadaAccess))
        throw new VaultError("invalid", "The access launch route requires armadaAccessVersion 1 and armadaAccess.");
      return launchRoute(options, caller, body);
    case "sandbox/launch-sized-v1":
      if (body.sizePolicyVersion !== 1)
        throw new VaultError("invalid", "The sized launch route requires sizePolicyVersion 1.");
      return launchRoute(options, caller, body);
    case "sandbox/launch":
      if (body.provider === "docker") {
        if (!options.dockerLaunch) throw new VaultError("unavailable", "Normal Docker launch is not configured.");
        return options.dockerLaunch.launch(await selectedCaller(options, caller, optional(body, "org")), body);
      }
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

export type GoldenJson = ReturnType<typeof goldenResponse> & { buildWarnings: string[] };

function goldenJson(row: GoldenRecord): GoldenJson {
  return { ...goldenResponse(row), buildWarnings: row.buildWarnings ?? [] };
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
  if (body.provider !== undefined && !isSandboxProvider(body.provider))
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
  const repos = config ? [] : requiredRepos(body);
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

async function measured<T>(
  options: ControlOptions,
  phase: import("./request-timing.ts").TimingPhase,
  work: () => Promise<T>,
): Promise<T> {
  return options.timing ? options.timing.measure(phase, work) : work();
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
  source?: "armada-runtime";
  runtimeFailure?: { status: "failed"; reason: string };
  olderCursor?: string;
}> {
  if (options.dockerControls) {
    const routed = await options.dockerControls.invoke(caller, "logs", {
      id,
      ...(body.cursor === undefined ? {} : { since_cursor: body.cursor }),
      ...(body.conversationId === undefined ? {} : { conversation_id: body.conversationId }),
      ...Object.fromEntries(
        ["limit", "all", "direction", "maxBytes", "coalesce", "follow"]
          .filter((key) => body[key] !== undefined)
          .map((key) => [key, body[key]]),
      ),
    });
    if (routed.handled) return routed.result as Awaited<ReturnType<typeof readLogs>>;
  }
  if (!options.logs) throw new VaultError("unavailable", "Sandbox logs are not configured on the server.");
  const target = await measured(options, "logs_target", () => options.logs!(caller, id));
  if (body.direction !== undefined && body.direction !== "forward" && body.direction !== "backward")
    throw new VaultError("invalid", "Invalid event direction.");
  for (const key of ["limit", "maxBytes"])
    if (body[key] !== undefined && typeof body[key] !== "number")
      throw new VaultError("invalid", "Invalid event pagination.");
  if (body.coalesce !== undefined && typeof body.coalesce !== "boolean")
    throw new VaultError("invalid", "Invalid coalesce option.");
  const backward = body.direction === "backward";
  const all = body.all === true;
  if (backward && all) throw new VaultError("invalid", "Backward reads cannot drain all pages.");
  let olderCursor: string | undefined;
  const follow = body.follow === true;
  const maxPages = 100;
  let cursor = optional(body, "cursor");
  let hasMore = false;
  let source: "armada-runtime" | undefined;
  let runtimeFailure: { status: "failed"; reason: string } | undefined;
  const events: Awaited<ReturnType<Provider["events"]>>["events"] = [];
  for (let pageNumber = 0; pageNumber < (all ? maxPages : 1); pageNumber += 1) {
    const page = await measured(options, "events", () =>
      target.provider.events({
        sandboxId: target.providerSandboxId,
        ...(cursor ? { cursor } : {}),
        ...(backward ? { direction: "backward" as const } : {}),
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
        ...(typeof body.maxBytes === "number" ? { maxBytes: body.maxBytes } : {}),
        ...(typeof body.coalesce === "boolean" ? { coalesce: body.coalesce } : {}),
        ...(optional(body, "conversationId") ? { conversationId: optional(body, "conversationId")! } : {}),
      }),
    );
    if (page.source) source = page.source;
    runtimeFailure = page.runtimeFailure ?? runtimeFailure;
    olderCursor = page.olderCursor;
    events.push(...page.events);
    hasMore = page.hasMore;
    const next = page.cursor ?? cursor;
    if (!page.hasMore || !next || next === cursor) {
      cursor = next;
      break;
    }
    cursor = next;
  }
  // Ordinary history reads need only the authorized event stream. Live compute is
  // consulted solely to decide whether a follow request should keep waiting.
  const info =
    follow && !runtimeFailure
      ? await measured(options, "state", () => target.provider.get(target.providerSandboxId))
      : null;
  const latest = latestPrompt(events);
  // A live sandbox with no turn is idle, so following has nothing to wait for.
  const prompt =
    follow && !runtimeFailure && latest && info?.state !== "stopped" && info?.state !== "failed"
      ? await measured(options, "prompt", () =>
          target.provider.getPrompt({ sandboxId: target.providerSandboxId, promptId: latest }),
        )
      : null;
  return {
    ...(source ? { source } : {}),
    ...(runtimeFailure ? { runtimeFailure } : {}),
    ...(olderCursor ? { olderCursor } : {}),
    events: dedupeEvents(events).filter((event) => !isPrivateModelEvent(event)),
    cursor: cursor ?? null,
    hasMore,
    settled:
      !follow ||
      runtimeFailure !== undefined ||
      info?.state === "stopped" ||
      info?.state === "failed" ||
      (latest === null ? info?.state !== "running" && info?.state !== "starting" : prompt?.done === true),
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

async function launchRoute(
  options: ControlOptions,
  caller: Caller,
  body: Record<string, unknown>,
  runtime: boolean | "modal" = false,
): Promise<unknown> {
  const modalRuntime = runtime === "modal";
  const runtimePolicy = modalRuntime ? options.modalRuntimeLaunch : runtime ? options.boatRuntimeLaunch : undefined;
  const runtimeHost = runtime && !modalRuntime ? options.runtimeHostFor : undefined;
  if (runtime && (!runtimePolicy || (!modalRuntime && !runtimeHost)))
    throw new VaultError("unavailable", "Experimental Boat runtime launch is not configured.");
  if (!runtime && (body.boatRuntime !== undefined || body.runtimeTransport !== undefined))
    throw new VaultError("invalid", "Use sandbox/launch-runtime-v1 for experimental runtime selection.");
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
  const armadaAccess = parseSandboxArmadaAccess(body.armadaAccess);
  if (armadaAccess && !options.sandboxArmadaAccess)
    throw new VaultError("unavailable", "Sandbox Armada access is not enabled on this server.");
  if (armadaAccess && (typeof body.credentialId !== "string" || !UUID.test(body.credentialId)))
    throw new VaultError("invalid", "Sandbox Armada access requires an explicit credentialId.");
  const name = required(body, "golden");
  const repo = body.repo === undefined ? undefined : required(body, "repo");
  const harness = required(body, "harness");
  if (!isHarness(harness)) throw new VaultError("invalid", "The agent is claude or codex.");
  const data = options.data(caller);
  const actor = await launchActor(data, caller, name, optional(body, "org"));
  const golden = await goldenForLaunch(
    data.goldens,
    actor,
    name,
    optional(body, "provider") as "boat" | "modal" | undefined,
  );
  resolveRepositoryDir(golden, optional(body, "repo"));
  if (armadaAccess && harness !== "codex")
    throw new VaultError("unavailable", "Sandbox Armada access is unavailable for this provider/harness.");
  if (runtime && golden.provider !== (modalRuntime ? "modal" : "boat"))
    throw new VaultError("invalid", "Runtime v1 requires a Boat golden.");
  const provider = modalRuntime
    ? await options.modalRuntimeHostFor!({ ...golden, runtimeTransport: "dialout" }, caller)
    : runtimeHost
      ? runtimeHost(
          (
            await resolveBoatKey(options.store, options.encryptionKey, {
              userId: caller.userId,
              orgId: actor.orgId,
              visibility: golden.visibility,
            })
          ).key,
        )
      : await providerForGolden(
          options,
          caller,
          modalRuntime
            ? { ...golden, runtimeTransport: "dialout" }
            : armadaAccess
              ? { ...golden, visibility: "private", sourceGoldenVisibility: golden.visibility }
              : golden,
        );
  const connectionLifecycle = runtime ? options.runtimeMcp?.connections : options.connections;
  const result = await launchSandbox(
    provider,
    {
      ...(options.skillDefaults ? { skillDefaults: options.skillDefaults } : {}),
      goldens: data.goldens,
      sandboxes: data.sandboxes,
      ...(connectionLifecycle ? { connections: connectionLifecycle } : {}),
      credentials: launchCredentials(
        options.store,
        options.encryptionKey,
        runtime
          ? undefined
          : {
              store: options.store,
              app: options.github?.app ?? null,
              ...(options.github?.fetch ? { fetch: options.github.fetch } : {}),
              ...(options.github?.now ? { now: options.github.now } : {}),
            },
        options.modelAuth,
      ),
    },
    actor,
    {
      ...(body.credentialId !== undefined ? { credentialId: required(body, "credentialId") } : {}),
      golden: name,
      ...(body.size === undefined ? {} : { size: parseMachineSize(body.size) }),
      provider: golden.provider,
      ...(repo === undefined ? {} : { repo }),
      ...(body.visibility === undefined ? {} : { visibility: body.visibility as "private" | "org" }),
      ...(body.skipSkillDefaults === undefined ? {} : { skipSkillDefaults: body.skipSkillDefaults as boolean }),
      ...(body.skills === undefined ? {} : { skills: body.skills as string[] }),
      ...(body.helperCapabilities === undefined ? {} : { helperCapabilities: body.helperCapabilities as string[] }),
      ...(body.connections === undefined ? {} : { connections: body.connections as string[] }),
      ...modelChoice(harness, optional(body, "model"), optional(body, "reasoningEffort")),
      harness,
      ...(optional(body, "prompt") === undefined ? {} : { prompt: required(body, "prompt") }),
      ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: requiredNumber(body, "ttlSeconds") }),
    },
    {
      ...options.launch,
      ...(runtimePolicy ? (modalRuntime ? { runtime: runtimePolicy } : { boatRuntime: runtimePolicy }) : {}),
      ...(armadaAccess
        ? {
            privateVisibility: true as const,
            beforeStart: async (provider: Provider, sandbox: import("@armada/core").SandboxRecord) => {
              await options.launch?.beforeStart?.(provider, sandbox);
              await options.sandboxArmadaAccess?.prepare(provider, sandbox, actor, armadaAccess);
            },
          }
        : {}),
    },
  );
  return {
    ...launchJson(result),
    ...(armadaAccess
      ? { armadaAccess: { enabled: true, maxActiveChildren: armadaAccess.maxActiveChildren ?? 3 } }
      : {}),
  };
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

/** One launch path for interactive templates and unattended owner-scoped routines. */
export function templateRuntime(options: ControlOptions, caller: Caller) {
  const stores = options.data?.(caller);
  if (!stores) return undefined;
  return {
    stores: {
      goldens: stores.goldens,
      sandboxes: stores.sandboxes,
      credentials: launchCredentials(
        options.store,
        options.encryptionKey,
        options.github ? { ...options.github, store: options.store } : undefined,
        options.modelAuth,
      ),
      ...(options.connections ? { connections: options.connections } : {}),
    },
    ...(options.dockerLaunch
      ? {
          launchDocker: (
            body: Record<string, unknown>,
            admission: {
              beforeReserve(tx: import("@armada/core").Sql): Promise<void>;
              beforeStart(): Promise<void>;
            },
          ) => options.dockerLaunch!.launch(caller, body, admission),
        }
      : {}),
    provider: (golden: GoldenRecord) => providerForGolden(options, caller, golden),
    ...(options.launch ? { options: options.launch } : {}),
  };
}

async function providerForGolden(
  options: ControlOptions,
  caller: Caller,
  golden: GoldenRecord & { sourceGoldenVisibility?: Visibility; runtimeTransport?: "dialout" },
): Promise<Provider> {
  if (options.providers) return options.providers.resolve(golden, caller);
  if (golden.provider !== "boat")
    throw new ProviderRoutingError("provider_not_configured", "modal", "Modal is not configured.");
  const key = await resolveBoatKey(options.store, options.encryptionKey, {
    userId: caller.userId,
    orgId: golden.orgId,
    visibility: golden.sourceGoldenVisibility ?? golden.visibility,
  });
  return (
    options.providerFor?.(key.key, { userId: caller.userId, orgId: golden.orgId }) ??
    Promise.reject(new VaultError("unavailable", "Launching is not configured on this server."))
  );
}

function launchJson(result: LaunchResult) {
  return {
    ...(result.runtime ? { runtime: result.runtime } : {}),
    helper: result.helper,
    sandbox: {
      ...result.sandbox,
      boatId: result.sandbox.provider === "boat" ? result.sandbox.providerSandboxId : null,
    },
    golden: {
      ...result.golden,
      ...goldenCompatibilityIds(result.golden),
    },
    promptId: result.promptId ?? null,
    conversationId: result.conversationId ?? null,
    ttlSeconds: result.ttlSeconds,
    expiresAt: result.expiresAt?.toISOString() ?? null,
    github: {
      status: result.github.status,
      login: result.github.login ?? null,
      tokenExpiresAt: result.github.tokenExpiresAt ?? null,
      message: result.github.message ?? null,
    },
  };
}

function modelChoice(harness: Harness, model: string | undefined, reasoningEffort: string | undefined): ModelChoice {
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
  return readJsonBody(request, false);
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

function requiredRepos(body: Record<string, unknown>): string[] {
  const value = body.repos;
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item !== "")) {
    throw new VaultError("invalid", "repos must be a non-empty array of non-empty strings.");
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

function fail(
  status: number,
  code: string,
  message: string,
  details?: ToolApiError["details"] | Pick<LaunchError, "reason" | "action">,
): Response {
  return Response.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Wires the control API from the environment: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
 * `ARMADA_DATABASE_URL` (a privileged Postgres connection string, the Supabase `postgres` role)
 * and `ARMADA_ENCRYPTION_KEY`.
 */
export function controlOptionsFromEnv(env: Record<string, string | undefined>): ConfiguredControlOptions {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Set ${name}.`);
    return value;
  };
  // Share the server adapter and its validated pool budget, including transaction support.
  const sql = bunSql(need("ARMADA_DATABASE_URL"), databasePoolMax(env.ARMADA_DATABASE_POOL_MAX));
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
  const templates = createTemplateService(sql, encryptionKey);
  const lifecycle = () =>
    createMcpLifecycle({
      sql,
      registry,
      encryptionKey,
      origin: need("ARMADA_PUBLIC_URL"),
      prepareReadableVariables: templates.prepare,
    });
  const providerFor = (apiKey: string, caller?: { userId: string; orgId: string }) =>
    createBoatProvider({
      apiKey,
      beforePrompt: async (provider, id) => {
        if (caller) await lifecycle().beforePrompt(provider, id, caller);
      },
    });
  let modal: ReturnType<typeof createModalIntegration> | undefined;
  const modalIntegration = () =>
    (modal ??= createModalIntegration({
      sql,
      vault: store,
      encryptionKey,
      publicUrl: need("ARMADA_PUBLIC_URL"),
      github: { store, app: githubApp },
      beforePrompt: async (provider, id, caller) => {
        await lifecycle().beforePrompt(provider, id, caller);
      },
    }));
  const providers = providerRegistry({
    vault: store,
    encryptionKey,
    providerFor,
    modalTokensFor: async (target, caller) => (await modalIntegration()).modalTokensFor(target, caller),
    modalProviderFor: async (tokens, binding, context) =>
      (await modalIntegration()).modalProviderFor(tokens, binding, context),
  });
  let subscriptionMigration: ReturnType<typeof createSubscriptionMigration>;
  const modelAuth = createModelAuthOwnership(
    sql,
    encryptionKey,
    undefined,
    undefined,
    env.ARMADA_PUBLIC_URL
      ? {
          origin: env.ARMADA_PUBLIC_URL,
          prepareAccount: (actor, id, version) => subscriptionMigration.prepareAccount(actor, id, version),
          prepareTurn: (provider, id, caller) => subscriptionMigration.prepareTurn(provider, id, caller),
        }
      : undefined,
  );
  if (modelAuth.broker)
    subscriptionMigration = createSubscriptionMigration(
      sql,
      createHistoricalSandboxProviderResolver(providers),
      (provider, id, caller, quiesced) => modelAuth.capture(provider, id, caller, quiesced),
      modelAuth.broker,
    );
  return {
    ...(env.ARMADA_PUBLIC_URL ? { publicUrl: env.ARMADA_PUBLIC_URL } : {}),
    credentialBindingRecovery: createCredentialBindingRecovery(sql, encryptionKey),
    invitations: invitationsFromEnv(sql, env),
    templates,
    skillDefaults: createSkillDefaultsService(sql),
    routines: createRoutineService(sql),
    applicationVault: createApplicationVault(sql, encryptionKey),
    mcp: { registry },
    connections: createSqlMcpLaunchPort(sql, registry),
    authStore,
    supabase: { supabaseUrl, anonKey },
    encryptionKey,
    github: { app: githubApp },
    store,
    modelAuth,
    providerFor,
    modelUsage: createModelUsageApi(sql),
    goldenAdoption: createGoldenAdoption(sql),
    providers,
    storedProviderFor: async (target, caller) => (await modalIntegration()).storedProviderFor(target, caller),
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
  if (provider !== undefined && !isSandboxProvider(provider))
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

/** Both policies count bytes before decoding; vault bodies additionally require valid UTF-8. */
async function readVaultBody(request: Request): Promise<Record<string, unknown>> {
  return readJsonBody(request, true);
}

async function readJsonBody(request: Request, vault: boolean): Promise<Record<string, unknown>> {
  const invalid = (message: string) =>
    new VaultError("invalid", vault ? "Invalid application vault request." : message);
  const reader = vault ? request.body?.getReader() : undefined;
  const decoder = new TextDecoder("utf-8", { fatal: vault });
  let text = vault ? "" : await readBoundedText(request, MAX_BODY_BYTES),
    bytes = 0;
  try {
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > (vault ? 64 * 1024 : MAX_BODY_BYTES)) {
          // Do not drain an untrusted stream, or wait for its producer to finish cancellation.
          void reader.cancel().catch(() => {});
          throw invalid("The request is too large.");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    }
    if (!vault && text.trim() === "") return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalid("The request is not JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw invalid("The request is not a JSON object.");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (vault) throw invalid("");
    throw error;
  } finally {
    reader?.releaseLock();
  }
}
