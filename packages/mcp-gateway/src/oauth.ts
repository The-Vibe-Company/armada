import {
  buildDiscoveryUrls,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  selectClientAuthMethod,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAuthMetadataSchema, OpenIdProviderDiscoveryMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { endpoint, GatewayError, publicFetch, restrictedFetch } from "./network.ts";

export interface OAuthServiceBinding {
  endpoint: string;
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  tokenFormat?: "slack-user";
}
export interface OAuthGrant {
  /** Trusted registered-service policy, encrypted with the grant and pending state. */
  binding?: OAuthServiceBinding;
  issuer: string;
  resource: string;
  metadata: OAuthServerMetadata;
  client: OAuthClientInformationMixed;
  tokens: OAuthTokens;
  expiresAt: number;
  scopes: string[];
}
export interface StoredGrant {
  generation: string;
  version: string;
  sealed: string;
}
export interface PendingAuthorization {
  actorId: string;
  connectionId: string;
  expiresAt: number;
  sealed: string;
}
export interface OAuthStore {
  /** Current connect/revoke generation, including when no grant exists. */
  generation(connectionId: string): Promise<string>;
  /** Vault ciphertext only. Must enforce connection ownership separately. */
  readGrant(connectionId: string): Promise<StoredGrant | null>;
  /** Atomic compare-and-swap, including a non-revoked connection check. null means initial creation only. */
  saveGrant(
    connectionId: string,
    expectedVersion: string | null,
    sealed: string,
    generation: string,
    refreshOwner?: string,
  ): Promise<boolean>;
  /** Exclusive cross-process refresh claim, fenced by grant version. Never reclaim an ambiguous claim automatically. */
  claimRefresh(connectionId: string, version: string, generation: string, refreshOwner: string): Promise<boolean>;
  /** Atomic tombstone and grant deletion; must defeat outstanding CAS/claims and pending callbacks. */
  revoke(connectionId: string): Promise<void>;
  putPending(stateHash: string, record: PendingAuthorization): Promise<void>;
  /** Atomic one-time consumption, bound to actor and expiry; failed checks MUST NOT return the record. */
  takePending(stateHash: string, actorId: string, now: number): Promise<PendingAuthorization | null>;
}
export interface SecretBox {
  seal(plaintext: string): Promise<string>;
  open(ciphertext: string): Promise<string>;
}
export interface OAuthBrokerOptions {
  store: OAuthStore;
  vault: SecretBox;
  redirectUri: string;
  /** Trusted deployment option: HTTP is allowed only for a fixed loopback browser callback. */
  development?: boolean;
  clientMetadataUrl?: string;
  /** Must check actor membership/ownership and disabled/revoked state. */
  authorize(actorId: string, connectionId: string): Promise<void>;
  fetch?: FetchLike;
  now?: () => number;
}
export type OAuthServerMetadata = AuthorizationServerMetadata & {
  revocation_endpoint?: string | undefined;
  authorization_response_iss_parameter_supported?: boolean | undefined;
  revocation_endpoint_auth_methods_supported?: string[] | undefined;
};
interface PendingFlow {
  grant: Omit<OAuthGrant, "tokens" | "expiresAt">;
  verifier: string;
  generation: string;
  version: string | null;
}
const hash = async (value: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
const fail = (code: "unsupported" | "needs_reconnect" | "busy", action: string): never => {
  throw new GatewayError(code, action);
};

export async function discoverOAuthIssuer(
  issuer: string,
  fetcher: FetchLike = publicFetch,
): Promise<OAuthServerMetadata | undefined> {
  if (endpoint(issuer).href.includes("?"))
    throw new GatewayError("unsafe_endpoint", "Issuer identifiers cannot contain a query component.");

  async function discoverMetadata(issuer: string): Promise<OAuthServerMetadata | undefined> {
    for (const candidate of buildDiscoveryUrls(issuer)) {
      const candidateUrl = endpoint(candidate.url).href;
      const response = await restrictedFetch(fetcher, (url) => url.href === candidateUrl)(candidate.url);
      if (response.status === 404) {
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) throw new GatewayError("upstream", "Authorization metadata is unavailable.");
      // SDK 1.32.2's OIDC discovery schema strips RFC 9207 and revocation fields.
      const schema = (candidate.type === "oauth" ? OAuthMetadataSchema : OpenIdProviderDiscoveryMetadataSchema).extend({
        authorization_response_iss_parameter_supported: z.boolean().optional(),
        revocation_endpoint: z.url().optional(),
        revocation_endpoint_auth_methods_supported: z.array(z.string()).optional(),
      });
      return schema.parse(await response.json());
    }
    return undefined;
  }
  function validateMetadata(issuer: string, metadata: OAuthServerMetadata) {
    if (metadata.issuer !== issuer) throw new GatewayError("unsafe_endpoint", "Discovery issuer mismatch.");
    for (const value of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.registration_endpoint,
      metadata.revocation_endpoint,
    ]) {
      if (value) endpoint(value);
    }
    if (!metadata.code_challenge_methods_supported?.includes("S256"))
      fail("unsupported", "Authorization server must advertise PKCE S256 support.");
  }
  const metadata = await discoverMetadata(issuer);
  if (metadata) validateMetadata(issuer, metadata);
  return metadata;
}

export function createOAuthBroker(options: OAuthBrokerOptions) {
  const { store, vault } = options;
  const now = options.now ?? Date.now;
  const fetcher = options.fetch ?? publicFetch;
  const callback = new URL(options.redirectUri);
  const developmentCallback =
    options.development === true &&
    callback.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname) &&
    !callback.username &&
    !callback.password &&
    !callback.search &&
    !callback.hash;
  if (!developmentCallback) endpoint(options.redirectUri);
  function purposeFetch(
    issuer: string,
    metadata: OAuthServerMetadata,
    purpose: "token_endpoint" | "registration_endpoint" | "revocation_endpoint",
    client?: OAuthClientInformationMixed,
    binding?: OAuthServiceBinding,
  ): FetchLike {
    if (metadata.issuer !== issuer || (client && client.issuer !== issuer))
      throw new GatewayError("unsafe_endpoint", "OAuth client and metadata must remain bound to the exact issuer.");
    const advertised = metadata[purpose];
    if (!advertised)
      throw new GatewayError("unsupported", "Authorization server did not advertise the required endpoint.");
    const pinned = endpoint(advertised).href;
    const exactFetch = restrictedFetch(fetcher, (url) => url.href === pinned);
    return async (input, init) => {
      if (init?.method !== "POST")
        throw new GatewayError("unsafe_endpoint", "OAuth endpoint only accepts its purpose-specific POST.");
      const response = await exactFetch(input, init);
      if (binding?.tokenFormat !== "slack-user" || purpose !== "token_endpoint" || !response.ok) return response;
      const payload = (await response.json()) as Record<string, unknown>;
      if (payload.ok !== true || payload.token_type !== "user")
        throw new GatewayError("needs_reconnect", "Slack did not issue a user token; reconnect.");
      const scope = payload.scope ?? (payload.authed_user as { scope?: unknown } | undefined)?.scope;
      return Response.json({
        ...payload,
        token_type: "Bearer",
        ...(typeof scope === "string" ? { scope: scope.replace(/,/g, " ") } : {}),
      });
    };
  }
  function completed(grant: Omit<OAuthGrant, "tokens" | "expiresAt">, tokens: OAuthTokens): OAuthGrant {
    if (
      tokens.token_type.toLowerCase() !== "bearer" ||
      (tokens.expires_in === undefined ? grant.binding?.tokenFormat !== "slack-user" : tokens.expires_in <= 0) ||
      (tokens.issuer && tokens.issuer !== grant.issuer)
    )
      fail("unsupported", "Expected an issuer-bound expiring bearer token.");
    const scopes = tokens.scope?.split(/\s+/).filter(Boolean) ?? grant.scopes;
    if (grant.scopes.some((scope) => !scopes.includes(scope)))
      fail("needs_reconnect", "Upstream did not grant the required scopes.");
    return {
      ...grant,
      tokens,
      scopes,
      expiresAt: tokens.expires_in === undefined ? Number.MAX_SAFE_INTEGER : now() + tokens.expires_in * 1000,
    };
  }
  const broker = {
    async connect(input: {
      actorId: string;
      connectionId: string;
      resource: string;
      client?: OAuthClientInformationMixed;
      scope?: string;
      resourceMetadataUrl?: string;
      /** Trusted server policy only; never accept this from a public request. */
      binding?: OAuthServiceBinding;
    }): Promise<{ authorizationUrl: string }> {
      await options.authorize(input.actorId, input.connectionId);
      const generation = await store.generation(input.connectionId);
      const resource = endpoint(input.resource).href;
      const resourceOrigin = endpoint(resource).origin;
      const resourceFetch = restrictedFetch(fetcher, (url) => url.origin === resourceOrigin);
      const probe = await resourceFetch(resource, { headers: { accept: "application/json, text/event-stream" } });
      const challenge = probe.status === 401 ? extractWWWAuthenticateParams(probe) : {};
      await probe.body?.cancel();
      const metadataUrl = input.resourceMetadataUrl ?? challenge.resourceMetadataUrl?.href;
      const prm = await discoverOAuthProtectedResourceMetadata(
        resource,
        metadataUrl ? { resourceMetadataUrl: metadataUrl } : {},
        resourceFetch,
      );
      const binding = input.binding;
      if (binding && (binding.endpoint !== resource || !input.client || input.client.issuer !== binding.issuer))
        throw new GatewayError("unsafe_endpoint", "Registered service binding mismatch.");
      if (binding ? prm.resource !== binding.resource : prm.resource !== input.resource && prm.resource !== resource)
        throw new GatewayError("unsafe_endpoint", "Protected resource identifier mismatch.");
      const issuer = prm.authorization_servers?.[0];
      if (!issuer) return fail("unsupported", "Configure an OAuth authorization server for this resource.");
      if (binding && issuer !== binding.issuer)
        throw new GatewayError("unsafe_endpoint", "Registered service issuer mismatch.");
      endpoint(issuer);
      const metadata = await discoverOAuthIssuer(issuer, fetcher);
      if (!metadata)
        return fail("unsupported", "Authorization server discovery is unavailable; configure a reviewed adapter.");
      if (
        binding &&
        (metadata.authorization_endpoint !== binding.authorizationEndpoint ||
          metadata.token_endpoint !== binding.tokenEndpoint ||
          !metadata.token_endpoint_auth_methods_supported?.includes(
            (input.client && "token_endpoint_auth_method" in input.client
              ? input.client.token_endpoint_auth_method
              : "") ?? "",
          ))
      )
        throw new GatewayError(
          "unsafe_endpoint",
          "Registered service OAuth endpoints or client authentication changed.",
        );
      const scopes =
        (binding ? input.scope : (challenge.scope ?? input.scope))?.split(/\s+/).filter(Boolean) ??
        prm.scopes_supported ??
        [];
      if (binding && (!scopes.length || scopes.some((scope) => !metadata.scopes_supported?.includes(scope))))
        throw new GatewayError("unsupported", "Registered service scopes are not supported.");
      let client = input.client;
      if (client && client.issuer !== issuer)
        throw new GatewayError("unsafe_endpoint", "Preregistered client must be bound to the exact issuer.");
      if (!client && metadata.client_id_metadata_document_supported && options.clientMetadataUrl)
        client = { client_id: endpoint(options.clientMetadataUrl).href, issuer };
      if (!client && metadata.registration_endpoint)
        client = {
          ...(await registerClient(issuer, {
            metadata,
            clientMetadata: {
              redirect_uris: [options.redirectUri],
              client_name: "Armada",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            },
            fetchFn: purposeFetch(issuer, metadata, "registration_endpoint"),
          })),
          issuer,
        };
      if (!client)
        return fail("unsupported", "Register Armada with this provider and supply its issuer-bound client ID.");
      const state = crypto.randomUUID() + crypto.randomUUID();
      const started = await startAuthorization(issuer, {
        metadata,
        clientInformation: client,
        redirectUrl: options.redirectUri,
        scope: scopes.join(" "),
        state,
        resource: prm.resource,
      });
      const previous = await store.readGrant(input.connectionId);
      const flow: PendingFlow = {
        grant: { issuer, resource: prm.resource, metadata, client, scopes, ...(binding ? { binding } : {}) },
        verifier: started.codeVerifier,
        generation,
        version: previous?.version ?? null,
      };
      await store.putPending(await hash(state), {
        actorId: input.actorId,
        connectionId: input.connectionId,
        expiresAt: now() + 600_000,
        sealed: await vault.seal(JSON.stringify(flow)),
      });
      return { authorizationUrl: started.authorizationUrl.href };
    },
    async callback(input: { actorId: string; state: string; code: string; issuer?: string }): Promise<void> {
      const pending = await store.takePending(await hash(input.state), input.actorId, now());
      if (!pending) throw new GatewayError("denied", "Authorization expired or was already consumed. Reconnect.");
      await options.authorize(input.actorId, pending.connectionId);
      const flow = JSON.parse(await vault.open(pending.sealed)) as PendingFlow;
      const { grant } = flow;
      if (
        (grant.metadata.authorization_response_iss_parameter_supported && !input.issuer) ||
        (input.issuer !== undefined && input.issuer !== grant.issuer)
      )
        throw new GatewayError("denied", "Authorization issuer mismatch.");
      const tokens = await exchangeAuthorization(grant.issuer, {
        metadata: grant.metadata,
        clientInformation: grant.client,
        authorizationCode: input.code,
        codeVerifier: flow.verifier,
        redirectUri: options.redirectUri,
        resource: grant.resource,
        fetchFn: purposeFetch(grant.issuer, grant.metadata, "token_endpoint", grant.client, grant.binding),
      });
      if (
        !(await store.saveGrant(
          pending.connectionId,
          flow.version,
          await vault.seal(JSON.stringify(completed(grant, tokens))),
          flow.generation,
        ))
      )
        fail("needs_reconnect", "Connection changed during authorization. Reconnect.");
    },
    async access(actorId: string, connectionId: string, resource: string): Promise<string> {
      await options.authorize(actorId, connectionId);
      const saved = await store.readGrant(connectionId);
      if (!saved) return fail("needs_reconnect", "Connect this service before use.");
      let grant = JSON.parse(await vault.open(saved.sealed)) as OAuthGrant;
      if ((grant.binding?.endpoint ?? grant.resource) !== resource)
        throw new GatewayError("denied", "Grant audience does not match this resource.");
      if (grant.expiresAt <= now() + 30_000) {
        if (!grant.tokens.refresh_token)
          return fail("needs_reconnect", "Provider did not issue a refresh token. Reconnect.");
        const refreshOwner = crypto.randomUUID();
        if (!(await store.claimRefresh(connectionId, saved.version, saved.generation, refreshOwner)))
          return fail("busy", "Refresh is in progress or has an uncertain outcome; retry status, not the operation.");
        let tokens: OAuthTokens;
        try {
          tokens = await refreshAuthorization(grant.issuer, {
            metadata: grant.metadata,
            clientInformation: grant.client,
            refreshToken: grant.tokens.refresh_token,
            resource: grant.resource,
            fetchFn: purposeFetch(grant.issuer, grant.metadata, "token_endpoint", grant.client, grant.binding),
          });
        } catch {
          return fail(
            "needs_reconnect",
            "Refresh failed or its outcome is uncertain. Reconnect; do not retry the old refresh token.",
          );
        }
        grant = completed(grant, tokens);
        if (
          !(await store.saveGrant(
            connectionId,
            saved.version,
            await vault.seal(JSON.stringify(grant)),
            saved.generation,
            refreshOwner,
          ))
        )
          return fail("needs_reconnect", "Grant was revoked or replaced during refresh.");
      }
      await options.authorize(actorId, connectionId);
      return grant.tokens.access_token;
    },
    async revoke(
      actorId: string,
      connectionId: string,
    ): Promise<{ upstreamRevocation: "done" | "unsupported" | "failed" }> {
      await options.authorize(actorId, connectionId);
      const saved = await store.readGrant(connectionId);
      await store.revoke(connectionId);
      if (!saved) return { upstreamRevocation: "done" };
      const grant = JSON.parse(await vault.open(saved.sealed)) as OAuthGrant;
      const url = grant.metadata.revocation_endpoint;
      if (!url) return { upstreamRevocation: "unsupported" };
      try {
        const body = new URLSearchParams({
          token: grant.tokens.refresh_token ?? grant.tokens.access_token,
          client_id: grant.client.client_id,
        });
        const headers = new Headers();
        const method = selectClientAuthMethod(
          grant.client,
          grant.metadata.revocation_endpoint_auth_methods_supported ?? ["client_secret_basic"],
        );
        if (method === "client_secret_basic" && grant.client.client_secret) {
          const encode = (value: string) => new URLSearchParams({ value }).toString().slice(6);
          headers.set(
            "authorization",
            `Basic ${btoa(`${encode(grant.client.client_id)}:${encode(grant.client.client_secret)}`)}`,
          );
        } else if (method === "client_secret_post" && grant.client.client_secret)
          body.set("client_secret", grant.client.client_secret);
        const response = await purposeFetch(
          grant.issuer,
          grant.metadata,
          "revocation_endpoint",
          grant.client,
        )(url, { method: "POST", headers, body });
        return { upstreamRevocation: response.ok ? "done" : "failed" };
      } catch {
        return { upstreamRevocation: "failed" };
      }
    },
  };
  function safe<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw new GatewayError("upstream", "OAuth operation failed. Check provider configuration or reconnect.");
      }
    };
  }
  return {
    connect: safe(broker.connect),
    callback: safe(broker.callback),
    access: safe(broker.access),
    revoke: safe(broker.revoke),
  };
}
export type OAuthBroker = ReturnType<typeof createOAuthBroker>;
