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

export { CONTROL_PREFIX, type ControlOptions, controlOptionsFromEnv, handleControlRequest } from "./control.ts";

/** What the server announces to MCP clients in its `initialize` answer. */
export const serverInfo = {
  name: "armada",
  version: VERSION,
} as const;

/**
 * Authentication for #464. Mount `handleOAuthRequest` before the MCP route.
 * Every MCP request calls `authenticate`; a failure answers with `oauthChallenge`.
 * Mount `handleControlRequest` beside it: it serves `/api/v1/` for `armada org` and `armada creds`
 * and answers null for any other path. Launch resolves credentials with `resolveCredentials` and
 * `resolveBoatKey` from `@armada/core`, in process, under the caller's `Principal`.
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
