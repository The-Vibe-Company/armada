import {
  type AuthResult,
  type AuthStore,
  authenticate,
  createServiceStore,
  handleOAuthRequest,
  type OAuthServerOptions,
  oauthChallenge,
  oauthOptionsFromEnv,
  type Principal,
} from "@armada/auth";
import { VERSION } from "@armada/core";

/** What the server announces to MCP clients in its `initialize` answer. */
export const serverInfo = {
  name: "armada",
  version: VERSION,
} as const;

/**
 * Authentication for #464. Mount `handleOAuthRequest` before the MCP route.
 * Every MCP request calls `authenticate`; a failure answers with `oauthChallenge`.
 * Neither call caches a principal, so a revoked token fails on the next request.
 */
export {
  type AuthResult,
  type AuthStore,
  authenticate,
  createServiceStore,
  handleOAuthRequest,
  type OAuthServerOptions,
  oauthChallenge,
  oauthOptionsFromEnv,
  type Principal,
};
