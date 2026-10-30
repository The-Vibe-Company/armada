import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bootDaemon } from "../src/boot.ts";
import { Keychain } from "../src/keychain.ts";
import { BUNDLED_PLUGINS } from "../src/plugins/catalog.ts";
import { connectionSecrets } from "../src/plugins/connection-secrets.ts";
import { fileKeychain } from "../src/secrets/file.ts";
import { modelEnvironment } from "../src/server/models.ts";

for (const source of ["prompt", "environment"])
  test(`custom model connection and creation agree after ${source} credential changes`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-model-"));
    const configPath = join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        plugins: [
          { id: "model-anthropic", config: { model: { anthropic: { apiKeySecret: "ARMADA_MODEL_API_KEY" } } } },
        ],
      }),
    );
    const key = randomBytes(24).toString("hex");
    const env = source === "environment" ? { ARMADA_MODEL_API_KEY: key } : {};
    const keychain = new Keychain(fileKeychain(join(dir, "keys")));
    const access = await modelEnvironment(env, keychain);
    const secrets = connectionSecrets(access.secrets, keychain, env);
    const daemon = await bootDaemon({
      databasePath: ":memory:",
      configPath,
      catalog: BUNDLED_PLUGINS.filter((p) => p.id === "model-anthropic"),
      secrets,
      log: { info() {}, error() {} },
    });
    try {
      const provider = daemon.registry.get("model", "anthropic");
      assert.ok(provider?.status && provider.connect && provider.disconnect);
      if (source === "prompt") {
        assert.equal((await provider.status()).state, "disconnected");
        await provider.connect({ notify() {}, prompt: async () => key });
        assert.equal(await keychain.read("plugin", "ARMADA_MODEL_API_KEY"), key);
      }
      assert.equal((await provider.status()).state, "connected");
      assert.ok(provider.create("claude-test"));
      await provider.disconnect();
      assert.equal(await keychain.read("plugin", "ARMADA_MODEL_API_KEY"), null);
      if (source === "environment") {
        assert.equal((await provider.status()).state, "connected");
        assert.ok(provider.create("claude-test"), "an upstream credential remains usable after removing the local key");
      } else {
        assert.equal((await provider.status()).state, "disconnected");
        assert.throws(() => provider.create("claude-test"), /credential is missing/);
      }
    } finally {
      daemon.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
