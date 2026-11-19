import type { AuthStore } from "@armada/auth";
import {
  goldenForSettings,
  PUBLIC_CONTROL_ROUTES,
  parseMachineSizePolicy,
  providerRateLimitDetails,
  VERSION,
  vaultControlRoute,
} from "@armada/core";
import {
  type ApplicationVault,
  assertGoldenMutation,
  type GitHubApp,
  type GoldenBuildJobs,
  GoldenError,
  type GoldenRecord,
  isSandboxProvider,
  LaunchError,
  type LaunchOptions,
  type LaunchStores,
  type Provider,
  ProviderError,
  type ProviderRegistry,
  type ProviderTarget,
  type RoutineService,
  resolveOrg,
  retainFailureDiagnostic,
  type SkillDefaultsService,
  type TemplateService,
  VaultError,
  type VaultStore,
} from "@armada/core/server";
import type { Caller, SupabaseProject } from "./caller.ts";
import { readBody, readVaultBody } from "./control-body.ts";
import { authenticatedCaller, scopedOrg, selectedCaller } from "./control-caller.ts";
import { controlFailureResponse } from "./control-errors.ts";
import { optional, required, UUID } from "./control-input.ts";
import { readLogs } from "./control-logs.ts";
import { fail } from "./control-response.ts";
import { sandboxToolContext } from "./control-tool-routes.ts";
import type { CredentialBindingRecovery } from "./credential-binding-recovery.ts";
import type { createSqlCredentialList } from "./credential-list-sql.ts";
import type { DataSource, ScopedData } from "./data.ts";
import type { GitHubAccountApi } from "./github-account.ts";
import { dispatchGitHubRestControl, isGitHubRestControl } from "./github-rest-controls.ts";
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
import { launchActor, templateRuntime } from "./launch-control.ts";
import { dispatchMcp, type McpControlOptions } from "./mcp-control.ts";
import type { ModelAuthOwnership } from "./model-auth.ts";
import type { ModelUsageApi } from "./model-usage.ts";
import { controlRoutes } from "./modules.ts";
import type { createOrdinaryLaunchReceipts } from "./ordinary-launch-receipts.ts";
import type { ProviderValidator } from "./org-provider.ts";
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
import { tokenCreateRoute, tokenListRoute, tokenRevokeRoute } from "./token-control.ts";
import { ToolApiError } from "./tool-api.ts";
import { describeToolFailure } from "./tool-failure.ts";

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
  const method = deletion ? "DELETE" : (controlRoutes.get(route)?.method ?? "POST");
  if (request.method !== method) return fail(405, "invalid", `Use ${method}.`);
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
  const registered = controlRoutes.get(route);
  if (registered) return registered.handler({ route, caller, body, options });
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
    const runtime = templateRuntime(options, caller);
    return options.templates.command(caller, route.slice(10), body, runtime);
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
  if (isGitHubRestControl(route)) {
    const context = await sandboxToolContext({ route, caller, body, options });
    return dispatchGitHubRestControl(
      { ...context, ...(options.runtimeGitHub ? { runtimeGitHub: options.runtimeGitHub } : {}) },
      route,
      body,
    );
  }
  const { store } = options;
  scopedOrg(caller, optional(body, "org"));
  switch (route) {
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

export { authenticatedControlCaller } from "./control-caller.ts";
export { controlOptionsFromEnv } from "./control-config.ts";

export type { GoldenJson } from "./golden-control.ts";

export { templateRuntime } from "./launch-control.ts";
