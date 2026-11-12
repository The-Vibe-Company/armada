import { CLAUDE_ENDPOINT_ENV, parseClaudeEndpoint } from "@armada/core";

/** Only the runtime translates a connection into native Claude gateway variables. */
export function configureClaudeEndpoint(env: Record<string, string>): void {
  const raw = env[CLAUDE_ENDPOINT_ENV];
  if (!raw) return;
  const endpoint = parseClaudeEndpoint(JSON.parse(raw));
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw Error("claude_gateway_credential_missing");
  delete env[CLAUDE_ENDPOINT_ENV];
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_BASE_URL = endpoint.baseUrl;
  env[endpoint.auth === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"] = key;
}
