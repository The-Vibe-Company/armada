import type { AuthStore } from "@armada/auth";
import {
  goldenForSettings,
  isModelConnectionTestResult,
  MAX_SANDBOX_EXTENSION_TTL_SECONDS,
  OPENCODE_ENDPOINT_ENV,
  PUBLIC_CONTROL_ROUTES,
  parseMachineSizePolicy,
  providerRateLimitDetails,
  VERSION,
  vaultControlRoute,
} from "@armada/core";
import { launch as launchOperation } from "@armada/core/contract";
import {
  type ApplicationVault,
  addMember,
  assertGoldenMutation,
  createOrg,
  createSkillCatalog,
  type GitHubApp,
  type GoldenActor,
  type GoldenBuildJobs,
  GoldenError,
  type GoldenRecord,
  isSandboxProvider,
  LaunchError,
  type LaunchOptions,
  type LaunchStores,
  listConnectionModels,
  listCredentials,
  listMembers,
  listOrgs,
  mutateCredentialAccount,
  type Provider,
  type ProviderRegistry,
  type ProviderTarget,
  parseCredentialKind,
  parseRole,
  type RoutineService,
  removeCredential,
  removeMember,
  resolveModelChoice,
  resolveOrg,
  resolveSkillpackCredential,
  retainFailureDiagnostic,
  type SkillDefaultsService,
  sandboxActivity,
  setCredential,
  setMemberRole,
  type TemplateService,
  VaultError,
  type VaultStore,
} from "@armada/core/server";
import { validateAzureModelAccount } from "./azure-model-account.ts";
import type { Caller, SupabaseProject } from "./caller.ts";
import { readBody, readVaultBody } from "./control-body.ts";
import { authenticatedCaller, scopedOrg } from "./control-caller.ts";
import { controlFailureResponse } from "./control-errors.ts";
import { optional, required, requiredNumber, UUID } from "./control-input.ts";
import { readLogs } from "./control-logs.ts";
import { fail } from "./control-response.ts";
import { CONTROL_TOOL_ROUTES } from "./control-tool-routes.ts";
import type { CredentialBindingRecovery } from "./credential-binding-recovery.ts";
import { listControlCredentials } from "./credential-list.ts";
import type { createSqlCredentialList } from "./credential-list-sql.ts";
import type { DataSource, ScopedData } from "./data.ts";
import { dockerLaunchRequestId } from "./docker-launch-identity.ts";
import type { GitHubAccountApi } from "./github-account.ts";
import {
  connectGoldenRoute,
  createGoldenRoute,
  listGoldens,
  selectGolden,
  snapshotGoldenRoute,
  updateGoldenRoute,
} from "./golden-control.ts";
import { GOLDEN_ADOPTION_REQUEST } from "./golden-rest-schemas.ts";
import type { Invitations } from "./invitations.ts";
import { launchActor, launchRoute, templateRuntime } from "./launch-control.ts";
import { exposedSecrets, launchCredentials } from "./launch-credentials.ts";
import { launchOptions, launchProviderOptions } from "./launch-options.ts";
import {
  GOLDEN_LAUNCH_REQUEST,
  PINNED_MODAL_LAUNCH_REQUEST,
  PINNED_MODAL_TEMPLATE_FIELDS,
} from "./launch-request-schema.ts";
import { canonicalLaunchResponse } from "./launch-response-schemas.ts";
import { dispatchMcp, type McpControlOptions } from "./mcp-control.ts";
import { type ModelAuthOwnership, modelAuthCapabilities } from "./model-auth.ts";
import type { ModelUsageApi } from "./model-usage.ts";
import type { createOrdinaryLaunchReceipts } from "./ordinary-launch-receipts.ts";
import {
  connectOrgProvider,
  disconnectOrgProvider,
  orgProviderStatus,
  type ProviderValidator,
  validateOrgProvider,
} from "./org-provider.ts";
import type { ProviderMetadataFor } from "./provider-metadata.ts";
import {
  authMethodsRoute,
  authorizeRoute,
  emailStartRoute,
  emailVerifyRoute,
  exchangeRoute,
  refreshRoute,
} from "./public-auth-control.ts";
import { recordOperatorFailure } from "./request-observability.ts";
import { measureRequestPhase, RequestTiming, withRequestTiming } from "./request-timing.ts";
import type { RuntimeCheckpoint } from "./runtime-checkpoint.ts";
import type { RuntimeFollowup } from "./runtime-followup.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";
import type { RuntimeMcp } from "./runtime-mcp.ts";
import type { RuntimeResume } from "./runtime-resume.ts";
import type { createSandboxArmadaAccess } from "./sandbox-armada-access.ts";
import { dispatchSandboxRestControl, isSandboxRestControl } from "./sandbox-rest-controls.ts";
import { tokenCreateRoute, tokenListRoute, tokenRevokeRoute } from "./token-control.ts";
import { callSharedTool, ToolApiError } from "./tool-api.ts";
import { describeToolFailure, sandboxListInput } from "./tools.ts";

import { viewerControl } from "./viewer-control.ts";

export const CONTROL_PREFIX = "/api/v1/";

export interface ControlOptions {
  /** Authenticated own-user metadata and current org membership in one snapshot. */
  listCredentialMetadata?: ReturnType<typeof createSqlCredentialList>;
  /** SQL list data must enforce fresh selection authority inside its page/count statement. */
  scopedSandboxData?: (caller: Caller, ref: string) => ScopedData;
  /** Optional read model combining fresh org resolution with visibility-filtered rows. */
  listGoldenRecords?: (caller: Caller, ref: string | undefined) => Promise<GoldenRecord[]>;
  sandboxBillingAccount?: (
    caller: Caller,
    id: string,
  ) => Promise<import("./sandbox-billing-account.ts").SandboxBillingAccount | null>;
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
  accountTurns?: import("./account-turn-queue.ts").AccountTurnQueue;
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
  /** Server-owned account admission; never selected or disabled by request JSON. */
  modelAccountValidator?: NonNullable<Parameters<typeof mutateCredentialAccount>[4]>;
  githubAccount?: GitHubAccountApi;
  goldenRetirements?: import("@armada/core/server").GoldenSnapshotRetirements;
  mcp?: NonNullable<McpControlOptions["mcp"]>;
  connections?: LaunchStores["connections"];
  /** Same verified bearer dependencies as MCP: Armada service/OAuth tokens and Supabase sessions. */
  authStore: AuthStore;
  supabase: SupabaseProject;
  now?: () => Date;
  /** Scoped golden/sandbox queries shared with MCP. */
  data?: DataSource;
  vault?: VaultStore;
  launch?: LaunchOptions;
  /** Durable launch receipts shared with MCP `launch`: `idempotencyKey` on REST launch routes. Absent: a keyed launch is refused. */
  ordinaryLaunchReceipts?: ReturnType<typeof createOrdinaryLaunchReceipts>;
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

/**
 * The CLI's way to the things that need the server: org creation and email lookup (service role)
 * and credential encryption (the encryption key). Every call is a POST with the person's Supabase
 * bearer accepted by MCP (Armada service/OAuth token or verified Supabase session); the answer is JSON. Returns null for any other path, so #464 mounts
 * this next to the OAuth routes. No request body, token or credential value is logged.
 */
export async function handleControlRequest(request: Request, options: ControlOptions): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(CONTROL_PREFIX)) return null;
  const viewer = await viewerControl(request, options, (next) => handleControlRequest(next, options));
  if (viewer) return viewer;
  const timing = new RequestTiming();
  const response = await withRequestTiming(timing, () =>
    timing.measure("total", () => timedControlRequest(request, { ...options, timing })),
  );
  const headers = new Headers(response.headers);
  headers.set("server-timing", timing.header());
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function timedControlRequest(
  request: Request,
  options: ControlOptions & { timing: RequestTiming },
): Promise<Response> {
  const url = new URL(request.url);
  const timing = options.timing;
  const route = url.pathname.slice(CONTROL_PREFIX.length);
  const publicHandlers: Record<keyof typeof PUBLIC_CONTROL_ROUTES, () => Response | Promise<Response>> = {
    "auth/methods": () => authMethodsRoute(request, options),
    "auth/authorize": () => authorizeRoute(request, options),
    "auth/exchange": () => exchangeRoute(request, options),
    "auth/email/start": () => emailStartRoute(request, options),
    "auth/email/verify": () => emailVerifyRoute(request, options),
    "auth/refresh": () => refreshRoute(request, options),
    "github/oauth/callback": () =>
      options.githubAccount
        ? options.githubAccount.callback(request)
        : fail(503, "dependency_unavailable", "GitHub account authorization is not configured."),
  };
  if (Object.hasOwn(PUBLIC_CONTROL_ROUTES, route)) {
    const publicRoute = route as keyof typeof PUBLIC_CONTROL_ROUTES;
    const methods: readonly string[] = PUBLIC_CONTROL_ROUTES[publicRoute];
    if (!methods.includes(request.method)) return fail(405, "invalid", `Use ${methods.join(" or ")}.`);
    return publicHandlers[publicRoute]();
  }
  if (route === "token/list") return tokenListRoute(request, options);
  if (route === "token/create") return tokenCreateRoute(request, options);
  if (route === "token/revoke") return tokenRevokeRoute(request, options);
  const deletion = /^sandboxes\/([0-9a-f-]+)$/i.exec(route);
  if (deletion ? request.method !== "DELETE" : request.method !== "POST")
    return fail(405, "invalid", deletion ? "Use DELETE." : "Use POST.");
  try {
    const caller = await timing.measure("auth", () => authenticatedCaller(request, options));
    if (vaultControlRoute(route) && url.search)
      throw new VaultError("invalid", "Parameters must be in the request body.");
    const body = deletion
      ? { id: deletion[1], org: url.searchParams.get("org") ?? undefined }
      : vaultControlRoute(route)
        ? await readVaultBody(request)
        : await readBody(request, route === "logs/read" ? 512 * 1024 : undefined);
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
        withRequestTiming(timing, () =>
          dispatchControlCommand(deletion ? "sandbox/delete" : route, caller, body, options),
        ),
      );
    if (result === undefined) return fail(404, "unknown_route", "Unknown route.");
    return Response.json(result, {
      status:
        (route === "golden/create" || route === "golden/update" || route === "golden/update-add-repos") &&
        typeof result === "object" &&
        result !== null &&
        "jobId" in result
          ? 202
          : 200,
      headers: { "cache-control": "no-store", "server-timing": timing.header() },
    });
  } catch (error) {
    const response = controlFailureResponse(error);
    if (response.status >= 500)
      recordOperatorFailure("control.dispatch", error, {
        sandboxId: error instanceof LaunchError ? error.sandboxId : undefined,
      });
    return response;
  }
}

export async function dispatchControlCommand(
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
      providers: launchProviderOptions(
        options.docker,
        Boolean(options.launch?.boatRuntimeDefault || options.launch?.boatEndpointRuntime),
      ),
      modalRuntime: {
        defaultPath: options.launch?.modalRuntimeDefault ? "runtime" : "native",
        enabled: Boolean(options.modalRuntimeLaunch),
        followupVersion: options.runtimeSend ? 1 : 0,
        idleLaunchVersion: options.modalRuntimeLaunch && options.runtimeSend ? 1 : 0,
        emptyResumeVersion: options.modalRuntimeLaunch && options.runtimeResume && options.runtimeSend ? 1 : 0,
        idleTemplateVersion:
          options.templates && options.modalRuntimeLaunch && options.modalRuntimeHostFor && options.runtimeSend ? 1 : 0,
        resumeVersion: options.runtimeResume && options.modalRuntimeLaunch ? 1 : 0,
        mcpVersion: options.runtimeMcp ? 2 : 0,
        skillsVersion: options.modalRuntimeLaunch ? 1 : 0,
        usageVersion: options.modalRuntimeLaunch ? 1 : 0,
        claudeVersion: options.modalRuntimeLaunch ? 1 : 0,
        opencodeVersion: options.modalRuntimeLaunch ? 1 : 0,
        opencodeShellProofVersion: options.modalRuntimeLaunch ? 1 : 0,
        opencodeMcpProofVersion: options.modalRuntimeLaunch && options.runtimeMcp ? 1 : 0,
        variablesVersion: options.templates && options.modalRuntimeLaunch && options.modalRuntimeHostFor ? 1 : 0,
      },
      dockerRuntime: {
        opencodeMcpProofVersion:
          options.docker?.hosts &&
          options.docker.placement &&
          options.docker.normalApi &&
          options.docker.normalLaunch &&
          options.docker.normalSend &&
          options.dockerLaunch &&
          options.dockerControls &&
          options.runtimeMcp
            ? 1
            : 0,
      },
      boatRuntime: {
        defaultPath: options.launch?.boatRuntimeDefault ? "runtime" : "native",
        diagnosticsVersion: 1,
        followupVersion: options.runtimeSend ? 1 : 0,
        checkpointVersion: options.runtimeCheckpoint ? 1 : 0,
        resumeVersion: options.runtimeResume ? 1 : 0,
        githubVersion: options.runtimeGitHub ? 1 : 0,
        mcpVersion: options.runtimeMcp ? 2 : 0,
        skillsVersion: options.boatRuntimeLaunch ? 1 : 0,
        workspaceVersion: options.boatRuntimeLaunch ? 1 : 0,
        controlsVersion: options.runtimeHostFor ? 1 : 0,
        opencodeVersion: options.boatRuntimeLaunch && options.runtimeHostFor ? 1 : 0,
        opencodeMcpProofVersion:
          options.templates &&
          options.launch?.boatRuntimeDefault &&
          options.boatRuntimeLaunch &&
          options.runtimeHostFor &&
          options.runtimeMcp &&
          options.runtimeSend
            ? 1
            : 0,
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
  if (route === "golden/adopt") {
    if (!options.data || !options.providers) throw new VaultError("unavailable", "Sandbox control is not configured.");
    const org = optional(body, "org");
    const scoped = await selectedCaller(options, caller, org);
    const input = GOLDEN_ADOPTION_REQUEST.safeParse({ ...body, org });
    if (!input.success) {
      const details = input.error.issues.map((issue) => `${issue.message} at ${issue.path.join(".")}`).join("\n");
      throw new ToolApiError(
        "internal",
        `MCP error -32602: Input validation error: Invalid arguments for tool golden_adopt: ${details}`,
      );
    }
    if (!options.goldenAdoption) throw new ToolApiError("unsupported", "Canonical adoption is not configured.");
    const data = options.data(scoped);
    try {
      for (const { orgId, role } of scoped.orgs) {
        const golden = (await data.goldens.list(orgId)).find((row) => row.id === input.data.id);
        if (!golden) continue;
        const actor = { userId: scoped.userId, orgId, role };
        assertGoldenMutation(actor, golden);
        const providers = options.providers;
        const provider = await measureRequestPhase(options.timing, "provider", () => providers.resolve(golden, scoped));
        return await options.goldenAdoption(provider, actor, golden, input.data.confirmation);
      }
      throw new GoldenError("not_found", "Canonical adoption unavailable.");
    } catch (error) {
      const { code, message } = describeToolFailure(error);
      const details =
        error instanceof ProviderError && code === "rate_limited"
          ? providerRateLimitDetails({ ...error.details, retryAfterSeconds: error.retryAfterSeconds })
          : undefined;
      throw retainFailureDiagnostic(new ToolApiError(code, message, details), error);
    }
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
      !(found.provider === "modal" || (found.provider === "boat" && found.boatRuntime)) ||
      !["ready", "running"].includes(found.status) ||
      found.stopRequestedAt ||
      !found.credentialId ||
      !found.credentialVersion
    )
      throw new VaultError(
        "conflict",
        "Connection checks require a running, bound Modal or Boat shared-runtime sandbox; no resume is performed.",
      );
    const harness = found.harness;
    if (harness !== "claude" && harness !== "codex" && harness !== "opencode")
      throw new VaultError("invalid", "Connection checks support Claude, Codex and custom OpenCode connections only.");
    const model = resolveModelChoice(harness, { model: required(body, "model") }).model;
    const credentials = launchCredentials(options.store, options.encryptionKey, undefined, options.modelAuth);
    const actor: GoldenActor = { userId: found.ownerId, orgId: found.orgId, role: "member" };
    const bound = await credentials.resolve(actor, found.harness, found.credentialId, found.credentialVersion);
    if (harness === "opencode") {
      if (!bound.env[OPENCODE_ENDPOINT_ENV] || !bound.env.OPENCODE_API_KEY)
        throw new VaultError("invalid", "OpenCode checks require a custom connection, not a plan key.");
    } else {
      const apiKey =
        harness === "codex"
          ? bound.env.OPENAI_API_KEY
          : (bound.env.ANTHROPIC_AUTH_TOKEN ?? bound.env.ANTHROPIC_API_KEY);
      if (!apiKey) throw new VaultError("invalid", "This check requires an API-key account, not a subscription.");
    }
    await credentials.assertTurn?.(actor, found.id, false);
    const provider = await options.providers.resolve(found, scoped);
    if (!provider.testModelConnection)
      throw new VaultError("unavailable", "Runtime connection checks are unavailable.");
    const testConnection = async (signal?: AbortSignal) => {
      const result = await provider.testModelConnection!({
        sandboxId: found.providerSandboxId,
        harness,
        model,
        ...(signal ? { signal } : {}),
      });
      if (!isModelConnectionTestResult(result)) throw new VaultError("unavailable", "Invalid connection-test receipt.");
      return result;
    };
    if (found.provider === "boat" && found.boatRuntime) {
      // Enqueued commands already fence idle checkpoint/stop under the owner/current epoch.
      // Generic activity generation handoffs would revoke this non-prompt runtime session.
      const test = await testConnection(AbortSignal.timeout(30000));
      return { id: found.id, test };
    }
    const machine = await provider.get(found.providerSandboxId);
    if (!["ready", "running"].includes(machine.state))
      throw new VaultError("conflict", "Sandbox must already be running.");
    const test = await sandboxActivity(
      data.sandboxes,
      found,
      {},
      async () => ({ result: await testConnection(), patch: {} }),
      { deadlineMs: 30000, failurePatch: () => ({}) },
    );
    return { id: found.id, test };
  }
  if (isSandboxRestControl(route)) {
    const { data, providers } = options;
    if (!data || !providers) throw new VaultError("unavailable", "Sandbox control is not configured.");
    const scopedCaller = await selectedCaller(options, caller, optional(body, "org"));
    return dispatchSandboxRestControl(route, scopedCaller, body, { ...options, data, providers });
  }
  const toolName = CONTROL_TOOL_ROUTES[route];
  if (toolName) {
    if (route === "sandbox/extend") {
      if (Object.hasOwn(body, "ttlSeconds") && Object.hasOwn(body, "ttl_seconds"))
        throw new VaultError("invalid", "Send one lifetime field: ttlSeconds.");
      const { ttlSeconds, ...fields } = body;
      const ttl = Object.hasOwn(body, "ttlSeconds") ? ttlSeconds : fields.ttl_seconds;
      if (Number.isSafeInteger(ttl) && Number(ttl) > MAX_SANDBOX_EXTENSION_TTL_SECONDS)
        throw new ToolApiError("extension_maximum", "Requested lifetime exceeds the server maximum.");
      if (!Number.isSafeInteger(ttl) || Number(ttl) < 1)
        throw new VaultError(
          "invalid",
          "ttlSeconds must be a positive whole number of seconds within the server maximum.",
        );
      body = { ...fields, ttl_seconds: ttl };
    }
    if (!options.data || !options.providers) throw new VaultError("unavailable", "Sandbox control is not configured.");
    const ref = optional(body, "org");
    const listRef =
      route === "sandbox/list" &&
      options.scopedSandboxData &&
      ref !== undefined &&
      sandboxListInput.safeParse(body).success
        ? scopedOrg(caller, ref)
        : undefined;
    const listOrgId = listRef && UUID.test(listRef.trim()) ? listRef.trim().toLowerCase() : undefined;
    const scopedCaller =
      listRef !== undefined
        ? listOrgId
          ? { ...caller, orgs: caller.orgs.filter((org) => org.orgId === listOrgId) }
          : caller
        : await selectedCaller(options, caller, ref);
    const result = await callSharedTool(
      {
        caller: scopedCaller,
        ...(options.sandboxBillingAccount
          ? { sandboxBillingAccount: (id: string) => options.sandboxBillingAccount!(scopedCaller, id) }
          : {}),
        ...(options.dockerControls ? { dockerControls: options.dockerControls } : {}),
        ...(options.runtimeSend ? { runtimeSend: options.runtimeSend } : {}),
        ...(options.accountTurns ? { accountTurns: options.accountTurns } : {}),
        ...(options.runtimeGitHub ? { runtimeGitHub: options.runtimeGitHub } : {}),
        ...(options.connections ? { connections: options.connections } : {}),
        data: listRef !== undefined ? options.scopedSandboxData!(scopedCaller, listRef) : options.data(scopedCaller),
        measure: (phase, work) => measureRequestPhase(options.timing, phase, work),
        storedProviders: options.storedProviderFor
          ? {
              modal: (target) =>
                measureRequestPhase(options.timing, "stored_provider", () =>
                  options.storedProviderFor!(target, scopedCaller),
                ),
            }
          : {},
        provider: (target) =>
          measureRequestPhase(options.timing, "provider", () =>
            options.providers
              ? options.providers.resolve(target, scopedCaller)
              : Promise.reject(new VaultError("unavailable", "Resource providers are not configured.")),
          ),
        deletionProvider: (sandbox) =>
          options.providers
            ? options.providers.resolve(sandbox, { userId: sandbox.ownerId })
            : Promise.reject(new VaultError("unavailable", "Resource providers are not configured.")),
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
    return result;
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
    case "creds/defaults/set": {
      const harness = required(body, "harness");
      if (harness !== "claude" && harness !== "codex" && harness !== "opencode")
        throw new VaultError("invalid", "Unknown agent.");
      const credentialId = body.credentialId === null ? null : required(body, "credentialId");
      const model = body.model === null ? null : required(body, "model");
      if (
        (credentialId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(credentialId)) ||
        (model && (!model.trim() || model.length > 256 || /\s/.test(model)))
      )
        throw new VaultError("invalid", "Invalid agent default.");
      if (model) resolveModelChoice(harness, { model });
      if (!store.setAgentDefault) throw new VaultError("unavailable", "Agent defaults unavailable.");
      const member = org ? await resolveOrg(store, userId, org) : undefined;
      await store.setAgentDefault(userId, { harness, credentialId, model }, member?.id);
      return { ok: true };
    }
    case "creds/accounts/limits":
    case "creds/accounts/set":
    case "creds/accounts/rename":
    case "creds/accounts/default":
    case "creds/accounts/remove": {
      const action = route.split("/").at(-1) as "set" | "rename" | "default" | "remove" | "limits";
      const account = await mutateCredentialAccount(
        store,
        encryptionKey,
        userId,
        {
          action,
          ...(body.model !== undefined ? { model: required(body, "model") } : {}),
          ...(body.maxAgents === undefined
            ? {}
            : { maxAgents: body.maxAgents === null ? null : requiredNumber(body, "maxAgents") }),
          ...(body.expectedVersion === undefined ? {} : { expectedVersion: requiredNumber(body, "expectedVersion") }),
          ...(optional(body, "expiresAt") ? { expiresAt: required(body, "expiresAt") } : {}),
          scope: scope(body),
          ...(org ? { org } : {}),
          ...(body.id !== undefined ? { id: required(body, "id") } : {}),
          ...(body.name !== undefined ? { name: required(body, "name") } : {}),
          ...(optional(body, "kind") ? { kind: parseCredentialKind(required(body, "kind")) } : {}),
          ...(optional(body, "value") ? { value: required(body, "value") } : {}),
        },
        options.modelAccountValidator ?? validateAzureModelAccount,
      );
      return { account };
    }
    case "creds/set":
      await setCredential(
        store,
        encryptionKey,
        userId,
        {
          scope: scope(body),
          org,
          kind: parseCredentialKind(required(body, "kind")),
          value: required(body, "value"),
        },
        options.modelAccountValidator ?? validateAzureModelAccount,
      );
      return { ok: true };
    case "creds/list":
      return options.listCredentialMetadata
        ? options.listCredentialMetadata(userId, org)
        : listControlCredentials(store, userId, org);
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
      return options.credentialBindingRecovery(
        caller,
        {
          id: required(body, "id"),
          credentialId: required(body, "credentialId"),
          // An org name or ID, resolved against fresh memberships like every other sandbox route.
          ...(org ? { org: (await resolveOrg(store, userId, org)).id } : {}),
        },
        async (id, sandboxOrg) => {
          const stopped = await dispatchControlCommand(
            "sandbox/stop",
            caller,
            { id, org: sandboxOrg, only_if_idle: true, request_id: crypto.randomUUID() },
            options,
          );
          if (!stopped || typeof stopped !== "object" || !("status" in stopped) || stopped.status !== "stopped")
            throw new VaultError(
              "credential_binding_unsafe",
              "Stop is still pending; wait for stopped and retry. The account is unchanged.",
            );
          if ("preservationNote" in stopped && stopped.preservationNote === "checkpoint_failed_disk_not_retained")
            throw new VaultError(
              "credential_binding_unsafe",
              "Checkpointing failed and retained compute cannot resume. The account is unchanged; inspect preserved work.",
            );
        },
      );
    case "golden/size-policy": {
      if (!options.data) throw new VaultError("unavailable", "Golden policies are not configured.");
      const data = options.data(caller);
      const name = required(body, "golden");
      const actor = await launchActor(data, caller, name, optional(body, "org"), store);
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
      if (body.toolInventory !== undefined && typeof body.toolInventory !== "boolean")
        throw new VaultError("invalid", "toolInventory must be boolean.");
      return options.runtimeMcp.preflight(caller, {
        org: required(body, "org"),
        connections: body.connections as string[],
        ...(body.toolInventory === true ? { toolInventory: true } : {}),
      });
    case "sandbox/github-preflight-v1":
      if (body.runtimeVersion !== 1 || !options.runtimeGitHub)
        throw new VaultError("unavailable", "Runtime GitHub v1 is unavailable.");
      return options.runtimeGitHub.preflight(caller, {
        org: required(body, "org"),
        golden: required(body, "golden"),
        repository: required(body, "repository"),
      });
    case "sandbox/launch":
      if (body.provider === "docker") {
        const parsed = launchOperation.input.body.safeParse(body);
        if (!parsed.success || parsed.data.provider !== "docker")
          throw new VaultError(
            "invalid",
            Object.hasOwn(body, "image")
              ? "Remove the image field and retry. Armada chooses the Docker environment automatically."
              : "Invalid Docker launch request.",
          );
        const dockerLaunch = options.dockerLaunch;
        if (!dockerLaunch) throw new VaultError("unavailable", "Normal Docker launch is not configured.");
        const organization = await resolveOrg(store, userId, org);
        const selected = { ...caller, orgs: caller.orgs.filter((item) => item.orgId === organization.id) };
        const launchDocker = (request: Record<string, unknown>) =>
          dockerLaunch.launch(selected, { ...request, org: organization.id });
        if ("idempotencyKey" in parsed.data) {
          if (!encryptionKey) throw new VaultError("unavailable", "Docker launch replay keys are unavailable.");
          const { idempotencyKey, ...request } = parsed.data;
          const requestId = dockerLaunchRequestId(encryptionKey, userId, organization.id, idempotencyKey);
          return canonicalLaunchResponse(await launchDocker({ ...request, requestId }));
        }
        return canonicalLaunchResponse(await launchDocker(parsed.data));
      }
      if (body.id !== undefined) {
        if (!PINNED_MODAL_LAUNCH_REQUEST.safeParse(body).success)
          throw new VaultError(
            "invalid",
            "Modal runtime templates require a pinned revision, organization UUID and unambiguous template fields.",
          );
      } else if (!GOLDEN_LAUNCH_REQUEST.safeParse(body).success) {
        throw new VaultError("invalid", "Invalid golden launch request. See the sandbox/launch request schema.");
      }

      if (body.runtimeTransport === "dialout") {
        if (!options.modalRuntimeLaunch || !options.modalRuntimeHostFor)
          throw new VaultError("unavailable", "Modal runtime staging opt-in is disabled.");
        if (body.prompt !== undefined) required(body, "prompt");
        if (body.prompt === undefined && !options.runtimeSend)
          throw new VaultError("unavailable", "Modal runtime idle first send is unavailable.");
        if (body.id !== undefined) {
          if (!options.templates) throw new VaultError("unavailable", "Templates unavailable.");
          const base = templateRuntime(options, caller);
          if (!base) throw new VaultError("unavailable", "Template launching unavailable.");
          const input = Object.fromEntries(
            PINNED_MODAL_TEMPLATE_FIELDS.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]),
          );
          return options.templates.command(caller, "launch", input, {
            validateDefinition: (definition) => {
              if (definition.provider !== "modal" || definition.harness !== body.harness)
                throw new VaultError("invalid", "Modal runtime templates require the selected Modal harness.");
            },
            stores: {
              goldens: base.stores.goldens,
              sandboxes: base.stores.sandboxes,
              credentials: launchCredentials(
                options.store,
                options.encryptionKey,
                undefined,
                options.modelAuth,
                options.github ? { ...options.github, store: options.store } : undefined,
              ),
              ...(options.runtimeMcp ? { connections: options.runtimeMcp.connections } : {}),
            },
            provider: (golden) => options.modalRuntimeHostFor!({ ...golden, runtimeTransport: "dialout" }, caller),
            options: { ...base.options, runtime: options.modalRuntimeLaunch },
          });
        }
        return canonicalLaunchResponse(await launchRoute(options, caller, body, "modal"));
      }
      if (body.boatRuntime === true) {
        if (!options.boatRuntimeLaunch || !options.runtimeHostFor)
          throw new VaultError("unavailable", "Experimental Boat runtime launch is not configured.");
        return canonicalLaunchResponse(await launchRoute(options, caller, body, true));
      }
      return canonicalLaunchResponse(await launchRoute(options, caller, body));
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
      return options.listGoldenRecords
        ? listGoldens(options, caller, optional(body, "org"))
        : listGoldens(options, await selectedCaller(options, caller, optional(body, "org")));
    case "golden/build/find": {
      if (!options.goldenBuilds || !options.data)
        throw new VaultError("unavailable", "Durable golden builds are not configured.");
      const scoped = await selectedCaller(options, caller, optional(body, "org"));
      const org = await resolveOrg(options.store, caller.userId, scopedOrg(scoped, optional(body, "org")));
      const golden = selectGolden(await options.data(scoped).goldens.findByName(org.id, required(body, "name")), body);
      if (!golden)
        throw new GoldenError(
          "not_found",
          "No visible golden has that name and provider. Check golden list in the intended organization.",
        );
      return { build: await options.goldenBuilds.findActive(caller.userId, golden.id, [org.id]) };
    }
    case "golden/build/cancel": {
      if (!options.goldenBuilds) throw new VaultError("unavailable", "Durable golden builds are not configured.");
      const scoped = await selectedCaller(options, caller, optional(body, "org"));
      return options.goldenBuilds.cancel(
        caller.userId,
        required(body, "jobId"),
        scoped.orgs.map((org) => org.orgId),
      );
    }
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
    case "golden/update-add-repos":
      return updateGoldenRoute(options, caller, body, true);
    case "golden/snapshot":
      return snapshotGoldenRoute(options, caller, body);
    case "golden/connect":
      return connectGoldenRoute(options, caller, body);
    default:
      return undefined;
  }
}

function scope(body: Record<string, unknown>): "user" | "org" {
  const value = required(body, "scope");
  if (value === "user" || value === "org") return value;
  throw new VaultError("invalid", "scope is user or org.");
}

async function selectedCaller(options: ControlOptions, caller: Caller, ref: string | undefined): Promise<Caller> {
  if (ref === undefined) return caller;
  const org = await resolveOrg(options.store, caller.userId, scopedOrg(caller, ref));
  return { ...caller, orgs: caller.orgs.filter((item) => item.orgId === org.id) };
}

export { authenticatedControlCaller } from "./control-caller.ts";
export { controlOptionsFromEnv } from "./control-config.ts";

export type { GoldenJson } from "./golden-control.ts";

export { templateRuntime } from "./launch-control.ts";
