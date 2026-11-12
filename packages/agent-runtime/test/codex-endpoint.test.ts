import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureCodexEndpoint } from "../src/codex-endpoint.ts";

test("runtime owns private Responses config and removes it when restoring a default account", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-endpoint-"));
  try {
    await configureCodexEndpoint(home, {
      version: 1,
      baseUrl: "https://example.com/openai/v1/responses",
      apiVersion: "2025-04-01-preview",
    });
    const config = Bun.TOML.parse(await readFile(join(home, "config.toml"), "utf8")) as any;
    expect(config.model_provider).toBe("armada");
    expect(config.model_providers.armada).toEqual({
      name: "Armada connection",
      base_url: "https://example.com/openai/v1",
      env_key: "OPENAI_API_KEY",
      wire_api: "responses",
      requires_openai_auth: false,
      query_params: { "api-version": "2025-04-01-preview" },
    });
    expect((await stat(join(home, "config.toml"))).mode & 0o777).toBe(0o600);
    await configureCodexEndpoint(home);
    expect(await Bun.file(join(home, "config.toml")).exists()).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
