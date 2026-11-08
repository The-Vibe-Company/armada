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

export {
  AuthUnavailable,
  authenticateCaller,
  bearerToken,
  type Caller,
  type CallerResult,
  type SupabaseProject,
  verifySupabaseUser,
} from "./caller.ts";
export { configFromEnv, DEFAULT_PORT, type ServerConfig } from "./config.ts";
export { CONTROL_PREFIX, type ControlOptions, controlOptionsFromEnv, handleControlRequest } from "./control.ts";
export { createSqlData, type DataSource, type SandboxView, type ScopedData } from "./data.ts";
export { createHandler, type HandlerOptions, HEALTH_PATH, MCP_PATH, type Route } from "./http.ts";
export { exposedSecrets, launchCredentials } from "./launch-credentials.ts";
export { bunSql, startServer } from "./serve.ts";
export { createArmadaServer, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, type ToolContext } from "./tools.ts";
export {
  latestPrompt,
  type PromptReport,
  readStatus,
  type StatusReport,
  WAIT_POLL_MS,
  waitSettled,
} from "./turns.ts";

/** What the server announces to MCP clients in its `initialize` answer. */
export const serverInfo = {
  name: "armada",
  version: VERSION,
} as const;

/**
 * Authentication, re-exported. The server mounts `handleOAuthRequest` before `/mcp`, authenticates every
 * MCP request with no cache (`authenticateCaller`), and answers a failure with `oauthChallenge`. Mount
 * `handleControlRequest` beside it for the CLI's `/api/v1/` routes.
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
