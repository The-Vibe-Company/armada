import { type AuthStore, handleOAuthRequest, type OAuthServerOptions, oauthChallenge } from "@armada/auth";
import { type CredentialReader, type LaunchOptions, type Provider, resolveBoatKey, VERSION } from "@armada/core";
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
import { createArmadaServer } from "./tools.ts";

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/healthz";

/** A handler for some paths: null for every other one. */
export type Route = (request: Request) => Promise<Response | null>;

export interface HandlerOptions {
  publicUrl: string;
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
  providerFor(apiKey: string): Provider;
  /** Mounted after the OAuth routes and before `/mcp`, for example #461's control API. */
  routes?: readonly Route[];
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  launch?: LaunchOptions;
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
    if (url.pathname === HEALTH_PATH) {
      return Response.json({ ok: true, version: VERSION }, { headers: { "cache-control": "no-store" } });
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
        data: options.data(caller),
        launchCredentials: launchCredentials(options.vault, options.encryptionKey, options.github),
        exposedSecrets: (orgId) =>
          exposedSecrets(options.vault, options.encryptionKey, { userId: caller.userId, orgId }),
        async provider(golden) {
          const { key } = await resolveBoatKey(options.vault, options.encryptionKey, {
            userId: caller.userId,
            orgId: golden.orgId,
            visibility: golden.visibility,
          });
          return options.providerFor(key);
        },
        now,
        sleep,
        logError: log,
        ...(options.launch ? { launch: options.launch } : {}),
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
