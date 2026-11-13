import { OPENCODE_CONNECTION_PROVIDER, OPENCODE_ENDPOINT_ENV, parseOpenCodeEndpoint } from "@armada/core";

/** Memory-only private configuration. Never write API keys or provider options into project/golden files. */
export function configureOpenCodeEndpoint(env: Record<string, string>): void {
  env.OPENCODE_DISABLE_AUTOUPDATE = "true";
  env.OPENCODE_DISABLE_MODELS_FETCH = "true";
  // Native child-session graphs are not part of the portable session export contract yet.
  const execution = {
    default_agent: "build",
    permission: { task: "deny" },
    agent: { title: { disable: true }, build: { disable: false, permission: { task: "deny" } } },
  };
  const raw = env[OPENCODE_ENDPOINT_ENV];
  if (!raw) {
    if (env.OPENCODE_API_KEY) env.OPENCODE_CONFIG_CONTENT = JSON.stringify(execution);
    return;
  }
  const endpoint = parseOpenCodeEndpoint(JSON.parse(raw));
  const apiKey = env.OPENCODE_API_KEY;
  if (!apiKey) throw Error("opencode_endpoint_key_missing");
  const baseUrl = new URL(endpoint.baseUrl);
  // Pinned Azure SDK appends /v1 itself on *.openai.azure.com, but not on Foundry hosts.
  if (endpoint.protocol === "azure" && baseUrl.hostname.endsWith(".openai.azure.com"))
    baseUrl.pathname = baseUrl.pathname.replace(/\/v1$/, "");
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    // Armada owns names; avoid unreported title traffic and uncheckpointed native child sessions.
    ...execution,
    enabled_providers: [OPENCODE_CONNECTION_PROVIDER],
    provider: {
      [OPENCODE_CONNECTION_PROVIDER]: {
        npm:
          endpoint.protocol === "anthropic"
            ? "@ai-sdk/anthropic"
            : endpoint.protocol === "azure"
              ? "@ai-sdk/azure"
              : "@ai-sdk/openai-compatible",
        name: "Armada model connection",
        options: {
          baseURL: endpoint.protocol === "azure" ? baseUrl.toString().replace(/\/+$/, "") : endpoint.baseUrl,
          apiKey,
        },
        models: Object.fromEntries(endpoint.models.map((id) => [id, { name: id }])),
      },
    },
  });
  delete env[OPENCODE_ENDPOINT_ENV];
  delete env.OPENCODE_API_KEY;
}
