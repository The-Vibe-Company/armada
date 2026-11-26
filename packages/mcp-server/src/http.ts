import { type AuthStore, handleOAuthRequest, type OAuthServerOptions, oauthChallenge } from "@armada/auth";
import {
  CLIENT_CONFIG_PATH,
  type ClientConfig,
  type CredentialReader,
  createProviderRegistry,
  type LaunchOptions,
  type LaunchStores,
  type ModalBinding,
  type ModalTokenPair,
  type Provider,
  type ProviderRegistry,
  ProviderRoutingError,
  type ProviderTarget,
  resolveBoatKey,
  resolveModalTokens,
  VERSION,
} from "@armada/core/server";
import { AuthUnavailable, authenticateCaller, type Caller, type CallerResult, type SupabaseProject } from "./caller.ts";
import type { DataSource, SandboxView } from "./data.ts";
import { exposedSecrets, type GitHubLaunchOptions, launchCredentials } from "./launch-credentials.ts";
import type { LaunchDiscoveryOptions } from "./launch-options.ts";
import type { ModelAuthOwnership } from "./model-auth.ts";
import { withBoatManagementIdentity } from "./observed-boat.ts";
import { createObservedMcpTransport } from "./observed-mcp-transport.ts";
import { diagnosticSandboxId } from "./provider-sandbox-target.ts";
import { REQUEST_BODY_LIMIT_BYTES, withRequestBodyCeiling } from "./request-body-ceiling.ts";
import { observeRequest, recordOperatorFailure } from "./request-observability.ts";
import type { RuntimeFollowup } from "./runtime-followup.ts";
import type { SandboxLogReader } from "./runtime-history.ts";
import { createArmadaServer, type ToolContext } from "./tools.ts";

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/healthz";

function mcpCorsHeaders() {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "content-type, authorization, accept, mcp-protocol-version, mcp-session-id, last-event-id",
    "access-control-expose-headers": "mcp-session-id, www-authenticate",
    "access-control-max-age": "600",
  });
}

function withMcpCors(response: Response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of mcpCorsHeaders()) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** A handler for some paths: null for every other one. */
export type Route = (request: Request) => Promise<Response | null>;

type ModalConnectionPorts = {
  provider: Provider;
  captureRuntimeWork?: import("@armada/provider-modal").ModalRuntimeCapture;
};

export interface HandlerOptions {
  readOutputSnapshot?: ToolContext["readOutputSnapshot"];
  sandboxBillingAccount?: (
    caller: import("./caller.ts").Caller,
    id: string,
  ) => Promise<import("./sandbox-billing-account.ts").SandboxBillingAccount | null>;
  dockerControls?: import("./docker-sandbox-controls.ts").DockerSandboxControls;
  runtimeSend?: RuntimeFollowup;
  configureStopRequest?: (request: Request) => void;
  stopAdmissionShutdown?: AbortSignal | undefined;
  runtimeStopCheckpoint?: ToolContext["runtimeStopCheckpoint"];
  accountTurns?: import("./account-turn-queue.ts").AccountTurnQueue;
  runtimeProviderFor?: (
    apiKey: string | Provider,
    target: ProviderTarget,
    caller: { userId: string },
    captureRuntimeWork?: ModalConnectionPorts["captureRuntimeWork"],
  ) => Promise<Provider>;
  logProvider?(target: SandboxView, caller: Caller): Promise<SandboxLogReader>;
  modalJobReader?: ReturnType<typeof import("./runtime-history.ts").createModalJobReader>;
  storedProviderFor?: (target: ProviderTarget, caller: { userId: string }) => Promise<Provider>;
  /** Runtime readiness of the serving database pool; no credentials in the result. */
  ready?: () => Promise<boolean>;
  /** Public Git deployment identity; never a credential or arbitrary environment value. */
  commitSha?: string;
  /** Non-secret, already-resolved global policy. Not proof a provider paused. */
  idlePauseDelayMs?: number;
  modelAuth?: ModelAuthOwnership;
  publicUrl: string;
  /** Enabled social login providers. Empty by default: email login always works. */
  loginProviders?: ClientConfig["providers"];
  oauth: OAuthServerOptions;
  /** Token and membership lookup: service role, so it can read a token row by hash. */
  authStore: AuthStore;
  /** The project that checks a Supabase session bearer (the dashboard's). */
  supabase: SupabaseProject;
  data: DataSource;
  /** Ciphertext of the stored credentials: the server's privileged connection, read in this process. */
  vault: CredentialReader;
  /** `ARMADA_ENCRYPTION_KEY`. Decrypted values stay in this process: no tool returns one. */
  encryptionKey: string | undefined;
  /** Each caller's GitHub connection, refreshed at launch so git and gh in the sandbox act as them. */
  github?: GitHubLaunchOptions;
  /** A provider for one boat.dev key. The key is used in this process only. */
  providerFor(apiKey: string, caller?: { userId: string; orgId: string }, sandboxId?: string): Provider;
  /**
   * The Modal provider for a Modal golden or sandbox, given the caller's resolved Modal token pair and the
   * golden's pinned binding. Absent until the Modal adapter (#513): a Modal record then gets a typed
   * `provider_routing_unavailable`, never a Boat provider. The adapter must refuse tokens of another workspace
   * than `binding.workspace`, so a rotated or replaced token pair cannot redirect a pinned golden.
   */
  modalProviderFor?: (
    tokens: ModalTokenPair,
    binding: ModalBinding,
    context: {
      target: ProviderTarget;
      caller: { userId: string };
      credentialScope: "user" | "org";
    },
  ) => ModalConnectionPorts | Promise<ModalConnectionPorts>;
  /** Server-owned persisted credential provenance overrides fallback for an existing Modal binding. */
  modalTokensFor?: (
    target: ProviderTarget,
    caller: { userId: string },
  ) => Promise<ModalTokenPair & { scope: "user" | "org" }>;
  /** Mounted after the OAuth routes and before `/mcp`, for example #461's control API. */
  routes?: readonly Route[];
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  launch?: LaunchOptions;
  launchDiscovery?: LaunchDiscoveryOptions;
  admitModalLaunch?: import("./modal-launch-admission.ts").AdmitModalLaunch;
  skillDefaults?: import("@armada/core/server").SkillDefaultsService;
  connections?: LaunchStores["connections"];
  /** Where the real cause of a 503 goes. Defaults to stderr. Never given a token or a key. */
  log?: (line: string) => void;
  /** Ingress body ceiling; defaults to {@link REQUEST_BODY_LIMIT_BYTES}. Tests lower it. */
  maxRequestBodyBytes?: number;
}

/**
 * The whole server: `/healthz`, then the OAuth routes, then any mounted routes, then the MCP endpoint
 * (Streamable HTTP, stateless). Every MCP request is authenticated on its own, with no cache, so a
 * revoked token, a signed-out session or a removed membership fails the next call; a refusal is the
 * OAuth challenge. The bearer is an Armada token (service or OAuth access) or a Supabase session.
 */
export function createHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line: string) => console.error(line));

  const routeRequest = async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === CLIENT_CONFIG_PATH) {
      const config: ClientConfig = {
        version: 1,
        supabaseUrl: options.supabase.supabaseUrl,
        anonKey: options.supabase.anonKey,
        controlUrl: new URL(options.publicUrl).origin,
        providers: options.loginProviders ?? [],
      };
      return Response.json(config, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === HEALTH_PATH) {
      const ready = options.ready ? await options.ready().catch(() => false) : true;
      return Response.json(
        {
          ok: ready,
          version: VERSION,
          ...(options.commitSha && /^[a-f0-9]{40}$/.test(options.commitSha) ? { commit: options.commitSha } : {}),
          ...(typeof options.idlePauseDelayMs === "number" &&
          Number.isSafeInteger(options.idlePauseDelayMs) &&
          options.idlePauseDelayMs > 0
            ? { idlePauseDelayMs: options.idlePauseDelayMs }
            : {}),
          ...(!ready ? { reason: "database_unavailable" } : {}),
        },
        {
          status: ready ? 200 : 503,
          headers: { "cache-control": "no-store", ...(!ready ? { "retry-after": "5" } : {}) },
        },
      );
    }

    const oauth = await handleOAuthRequest(request, options.oauth);
    if (oauth) return oauth;
    for (const route of options.routes ?? []) {
      const answer = await route(request);
      if (answer) return answer;
    }
    if (url.pathname !== MCP_PATH) return Response.json({ error: "not_found" }, { status: 404 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: mcpCorsHeaders() });

    let auth: CallerResult;
    try {
      auth = await authenticateCaller(request.headers.get("authorization"), {
        store: options.authStore,
        supabase: options.supabase,
        now: now(),
      });
    } catch (error) {
      if (!(error instanceof AuthUnavailable)) throw error;
      recordOperatorFailure("mcp.authentication", error);
      return withMcpCors(
        Response.json({ error: "temporarily_unavailable" }, { status: 503, headers: { "retry-after": "5" } }),
      );
    }
    if (!auth.ok) return withMcpCors(oauthChallenge(options.publicUrl));
    const caller = auth.caller;

    const server = createArmadaServer(
      {
        caller,
        ...(options.readOutputSnapshot ? { readOutputSnapshot: options.readOutputSnapshot } : {}),
        outputSignal: request.signal,
        configureStopRequest: () => options.configureStopRequest?.(request),
        stopSignal: options.stopAdmissionShutdown
          ? AbortSignal.any([request.signal, options.stopAdmissionShutdown])
          : request.signal,
        ...(options.sandboxBillingAccount
          ? { sandboxBillingAccount: (id: string) => options.sandboxBillingAccount!(caller, id) }
          : {}),
        ...(options.dockerControls ? { dockerControls: options.dockerControls } : {}),
        ...(options.runtimeSend ? { runtimeSend: options.runtimeSend } : {}),
        ...(options.runtimeStopCheckpoint ? { runtimeStopCheckpoint: options.runtimeStopCheckpoint } : {}),
        ...(options.accountTurns ? { accountTurns: options.accountTurns } : {}),
        ...(options.skillDefaults ? { skillDefaults: options.skillDefaults } : {}),
        ...(options.connections ? { connections: options.connections } : {}),
        data: options.data(caller),
        launchCredentials: launchCredentials(options.vault, options.encryptionKey, options.github, options.modelAuth),
        exposedSecrets: (orgId) =>
          exposedSecrets(options.vault, options.encryptionKey, { userId: caller.userId, orgId }),
        ...(options.logProvider ? { logProvider: (target) => options.logProvider!(target, caller) } : {}),
        ...(options.modalJobReader ? { modalJobReader: (target) => options.modalJobReader!(target, caller) } : {}),
        storedProviders: options.storedProviderFor
          ? { modal: (target) => options.storedProviderFor!(target, caller) }
          : {},
        provider: (target) => providerRegistry(options).resolve(target, caller),
        now,
        sleep,
        logError: log,
        ...(options.admitModalLaunch ? { admitModalLaunch: options.admitModalLaunch } : {}),
        ...(options.launch ? { launch: options.launch } : {}),
      },
      VERSION,
      options.launchDiscovery ?? options,
    );
    const transport = createObservedMcpTransport();
    await server.connect(transport);
    try {
      return withMcpCors(await transport.handleRequest(request));
    } finally {
      await server.close();
    }
  };
  const bodyLimit = options.maxRequestBodyBytes ?? REQUEST_BODY_LIMIT_BYTES;
  return (request) =>
    observeRequest(() => withRequestBodyCeiling(request, bodyLimit, routeRequest), options.log, request);
}

/**
 * Routes a record to its own provider with the caller's management credential for it: the boat.dev key for
 * Boat, the Modal token pair for Modal. Neither ever leaves this process.
 */
export function providerRegistry(
  options: Pick<
    HandlerOptions,
    "vault" | "encryptionKey" | "providerFor" | "modalProviderFor" | "modalTokensFor" | "runtimeProviderFor"
  >,
): ProviderRegistry {
  const modal = options.modalProviderFor;
  return createProviderRegistry({
    boat: async (target, caller) => {
      const runtime = target.boatRuntime ? options.runtimeProviderFor : undefined;
      if (target.boatRuntime && (!target.id || !runtime))
        throw new ProviderRoutingError(
          "provider_routing_unavailable",
          "boat",
          "Armada runtime routing is not configured.",
        );
      const { key, scope } = await resolveBoatKey(options.vault, options.encryptionKey, {
        userId: caller.userId,
        orgId: target.orgId,
        visibility: target.sourceGoldenVisibility ?? target.visibility,
      });
      const provider = runtime
        ? await runtime(key, target, caller)
        : options.providerFor(key, { userId: caller.userId, orgId: target.orgId }, diagnosticSandboxId(target));
      // Keep source authority immutable even if a provider factory caches a shared client.
      return withBoatManagementIdentity(provider, scope, scope === "org" ? target.orgId : caller.userId);
    },
    ...(modal
      ? {
          modal: async (target, caller) => {
            if (!target.modal) throw new Error("A Modal target carries its binding.");
            const tokens = options.modalTokensFor
              ? await options.modalTokensFor(target, caller)
              : await resolveModalTokens(options.vault, options.encryptionKey, {
                  userId: caller.userId,
                  orgId: target.orgId,
                  visibility: target.sourceGoldenVisibility ?? target.visibility,
                });
            const { provider: host, captureRuntimeWork } = await modal(
              { tokenId: tokens.tokenId, tokenSecret: tokens.tokenSecret },
              target.modal,
              {
                target,
                caller,
                credentialScope: tokens.scope,
              },
            );
            if (target.modalTransport === "dialout") {
              if (!options.runtimeProviderFor || !target.id) throw new Error("Runtime routing unavailable.");
              return options.runtimeProviderFor(host, target, caller, captureRuntimeWork);
            }
            return host;
          },
        }
      : {}),
  });
}
