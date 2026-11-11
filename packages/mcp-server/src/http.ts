import { type AuthStore, handleOAuthRequest, type OAuthServerOptions, oauthChallenge } from "@armada/auth";
import {
  CLIENT_CONFIG_PATH,
  type ClientConfig,
  type CredentialReader,
  createProviderRegistry,
  type GoldenBuildJobs,
  type LaunchOptions,
  type LaunchStores,
  type ModalBinding,
  type ModalTokenPair,
  type Provider,
  type ProviderRegistry,
  type ProviderTarget,
  resolveBoatKey,
  resolveModalTokens,
  VERSION,
} from "@armada/core/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  AuthUnavailable,
  authenticateCaller,
  type CallerResult,
  describeFailure,
  type SupabaseProject,
} from "./caller.ts";
import type { DataSource } from "./data.ts";
import { exposedSecrets, type GitHubLaunchOptions, launchCredentials } from "./launch-credentials.ts";
import { redactForLog } from "./log.ts";
import type { ModelAuthOwnership } from "./model-auth.ts";
import type { ProviderMetadataFor } from "./provider-metadata.ts";
import { createArmadaServer } from "./tools.ts";

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/healthz";

/** A handler for some paths: null for every other one. */
export type Route = (request: Request) => Promise<Response | null>;

import type { SandboxAccessPair } from "./sandbox-access-activation.ts";

export interface HandlerOptions {
  storedProviderFor?: (target: ProviderTarget, caller: { userId: string }) => Promise<Provider>;
  /** Runtime readiness of the serving database pool; no credentials in the result. */
  ready?: () => Promise<boolean>;
  sandboxAccessPairs?: readonly SandboxAccessPair[];
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
  /** Secure, server-orchestrated multi-repo golden creation (`golden_create`). Absent: the tool refuses. */
  goldenBuilds?: GoldenBuildJobs;
  goldenAdoption?: import("@armada/core/server").GoldenAdoption;
  /** A provider for one boat.dev key. The key is used in this process only. */
  providerFor(apiKey: string, caller?: { userId: string; orgId: string }): Provider;
  /**
   * The Modal provider for a Modal golden or sandbox, given the caller's resolved Modal token pair and the
   * golden's pinned binding. Absent until the Modal adapter (#513): a Modal record then gets a typed
   * `provider_not_configured`, never a Boat provider. The adapter must refuse tokens of another workspace
   * than `binding.workspace`, so a rotated or replaced token pair cannot redirect a pinned golden.
   */
  modalProviderFor?: (
    tokens: ModalTokenPair,
    binding: ModalBinding,
    context: {
      target: ProviderTarget;
      caller: { userId: string; orchestratorCleanup?: import("@armada/core").OrchestratorCleanupScope };
      credentialScope: "user" | "org";
    },
  ) => Provider | Promise<Provider>;
  /** Server-owned persisted credential provenance overrides fallback for an existing Modal binding. */
  modalTokensFor?: (
    target: ProviderTarget,
    caller: { userId: string },
  ) => Promise<ModalTokenPair & { scope: "user" | "org" }>;
  providerMetadata?: ProviderMetadataFor;
  goldenTarget?: (target: Omit<ProviderTarget, "modal">, caller: { userId: string }) => Promise<ProviderTarget>;
  /** Mounted after the OAuth routes and before `/mcp`, for example #461's control API. */
  routes?: readonly Route[];
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  launch?: LaunchOptions;
  templates?: import("@armada/core/server").TemplateService;
  skillDefaults?: import("@armada/core/server").SkillDefaultsService;
  applicationVault?: import("@armada/core/server").ApplicationVault;
  connections?: LaunchStores["connections"];
  /** Where the real cause of a 503 goes. Defaults to stderr. Never given a token or a key. */
  log?: (line: string) => void;
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

  return async (request) => {
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
        { ok: ready, version: VERSION, ...(!ready ? { reason: "database_unavailable" } : {}) },
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

    let auth: CallerResult;
    try {
      auth = await authenticateCaller(request.headers.get("authorization"), {
        store: options.authStore,
        supabase: options.supabase,
        now: now(),
      });
    } catch (error) {
      if (!(error instanceof AuthUnavailable)) throw error;
      log(redactForLog(`armada serve: /mcp authentication unavailable: ${describeFailure(error)}`));
      return Response.json({ error: "temporarily_unavailable" }, { status: 503, headers: { "retry-after": "5" } });
    }
    if (!auth.ok) return oauthChallenge(options.publicUrl);
    const caller = auth.caller;

    const server = createArmadaServer(
      {
        caller,
        ...(options.skillDefaults ? { skillDefaults: options.skillDefaults } : {}),
        ...(options.templates ? { templates: options.templates } : {}),
        ...(options.applicationVault ? { applicationVault: options.applicationVault } : {}),
        ...(options.connections ? { connections: options.connections } : {}),
        data: options.data(caller),
        launchCredentials: launchCredentials(options.vault, options.encryptionKey, options.github, options.modelAuth),
        exposedSecrets: (orgId) =>
          exposedSecrets(options.vault, options.encryptionKey, { userId: caller.userId, orgId }),
        ...(options.goldenTarget
          ? { goldenTarget: (target: Omit<ProviderTarget, "modal">) => options.goldenTarget!(target, caller) }
          : {}),
        ...(options.providerMetadata
          ? {
              providerMetadata: (selection) => options.providerMetadata!(selection, caller),
            }
          : {}),
        ...(options.storedProviderFor
          ? { storedProvider: (target: ProviderTarget) => options.storedProviderFor!(target, caller) }
          : {}),
        provider: (target) => providerRegistry(options).resolve(target, caller),
        deletionProvider: (sandbox) => providerRegistry(options).resolve(sandbox, { userId: sandbox.ownerId }),
        now,
        sleep,
        logError: log,
        ...(options.launch ? { launch: options.launch } : {}),
        ...(options.goldenAdoption ? { goldenAdoption: options.goldenAdoption } : {}),
        ...(options.goldenBuilds ? { goldenBuilds: options.goldenBuilds } : {}),
        ...(options.sandboxAccessPairs ? { sandboxAccessPairs: options.sandboxAccessPairs } : {}),
      },
      VERSION,
    );
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  };
}

/**
 * Routes a record to its own provider with the caller's management credential for it: the boat.dev key for
 * Boat, the Modal token pair for Modal. Neither ever leaves this process.
 */
export function providerRegistry(
  options: Pick<HandlerOptions, "vault" | "encryptionKey" | "providerFor" | "modalProviderFor" | "modalTokensFor">,
): ProviderRegistry {
  const modal = options.modalProviderFor;
  return createProviderRegistry({
    boat: async (target, caller) => {
      const { key, scope } = await resolveBoatKey(options.vault, options.encryptionKey, {
        userId: caller.userId,
        orgId: target.orgId,
        visibility: target.sourceGoldenVisibility ?? target.visibility,
      });
      const provider = options.providerFor(key, { userId: caller.userId, orgId: target.orgId });
      const authority = Object.freeze({ scope, ownerId: scope === "org" ? target.orgId : caller.userId });
      // Keep source authority immutable even if a provider factory caches a shared client.
      return new Proxy(provider, {
        get(instance, property) {
          if (property === "managementIdentity") return async () => authority;
          const value = Reflect.get(instance, property, instance);
          return typeof value === "function" ? value.bind(instance) : value;
        },
        set(instance, property, value) {
          return property !== "managementIdentity" && Reflect.set(instance, property, value, instance);
        },
      });
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
            return modal({ tokenId: tokens.tokenId, tokenSecret: tokens.tokenSecret }, target.modal, {
              target,
              caller,
              credentialScope: tokens.scope,
            });
          },
        }
      : {}),
  });
}
