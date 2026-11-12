import { chmod, rm, writeFile } from "node:fs/promises";
import { type CodexEndpoint, parseCodexEndpoint } from "@armada/core";

/** Runtime-owned config, never a project config or command-line secret. */
export async function configureCodexEndpoint(home: string, endpoint?: CodexEndpoint): Promise<void> {
  const path = `${home}/config.toml`;
  if (!endpoint) {
    await rm(path, { force: true });
    return;
  }
  const parsed = parseCodexEndpoint(endpoint);
  const content = [
    'model_provider = "armada"',
    "[model_providers.armada]",
    'name = "Armada connection"',
    `base_url = ${JSON.stringify(parsed.baseUrl)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    ...(parsed.apiVersion ? [`query_params = { "api-version" = ${JSON.stringify(parsed.apiVersion)} }`] : []),
    "",
  ].join("\n");
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}
