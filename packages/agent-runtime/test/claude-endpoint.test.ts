import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CLAUDE_ENDPOINT_ENV } from "@armada/core";
import { configureClaudeEndpoint } from "../src/claude-endpoint.ts";

test.each(["api-key", "bearer"] as const)("runtime selects only the gateway auth mechanism (%s)", (auth) => {
  const key = randomUUID();
  const env: Record<string, string> = {
    [CLAUDE_ENDPOINT_ENV]: JSON.stringify({ version: 1, baseUrl: "https://example.com/anthropic/", auth }),
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_AUTH_TOKEN: randomUUID(),
    CLAUDE_CODE_OAUTH_TOKEN: randomUUID(),
    HOME: "/home/user",
  };
  configureClaudeEndpoint(env);
  expect(env).toEqual({
    HOME: "/home/user",
    ANTHROPIC_BASE_URL: "https://example.com/anthropic",
    [auth === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"]: key,
  });
});

test("runtime leaves existing accounts alone and refuses a gateway without a credential", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: randomUUID() };
  const before = { ...env };
  configureClaudeEndpoint(env);
  expect(env).toEqual(before);
  expect(() =>
    configureClaudeEndpoint({
      [CLAUDE_ENDPOINT_ENV]: JSON.stringify({ version: 1, baseUrl: "https://example.com", auth: "bearer" }),
    }),
  ).toThrow("claude_gateway_credential_missing");
});
