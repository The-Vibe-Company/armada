import { OPENCODE_ENDPOINT_ENV, parseOpenCodeEndpoint } from "@armada/core";

/** Memory-only private configuration. Never write API keys or provider options into project/golden files. */
export function configureOpenCodeEndpoint(env: Record<string, string>): void {
  env.OPENCODE_DISABLE_AUTOUPDATE = "true";
  env.OPENCODE_DISABLE_MODELS_FETCH = "true";
  const raw = env[OPENCODE_ENDPOINT_ENV];
  if (!raw) return;
  const endpoint = parseOpenCodeEndpoint(JSON.parse(raw));
  const apiKey = env.OPENCODE_API_KEY;
  if (!apiKey) throw Error("opencode_endpoint_key_missing");
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["armada"],
    provider: {
      armada: {
        npm: "@ai-sdk/openai-compatible",
        name: "Armada model connection",
        options: { baseURL: endpoint.baseUrl, apiKey },
        models: Object.fromEntries(endpoint.models.map((id) => [id, { name: id }])),
      },
    },
  });
  delete env[OPENCODE_ENDPOINT_ENV];
  delete env.OPENCODE_API_KEY;
}
