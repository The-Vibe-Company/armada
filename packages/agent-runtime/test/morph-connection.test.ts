import { expect, test } from "bun:test";
import { CLAUDE_ENDPOINT_ENV, CODEX_ENDPOINT_ENV, encryptSecret, resolveCredentials } from "@armada/core/server";
import { configureClaudeEndpoint } from "../src/claude-endpoint.ts";

test("one encrypted Morph account delivers each harness's wire configuration", async () => {
  const encryptionKey = Buffer.alloc(32, 13).toString("base64");
  const valueEnc = await encryptSecret("morph_test_key", encryptionKey);
  const reader = {
    credentials: async () => [{ id: "account", kind: "morph" as const, valueEnc, version: 1 }],
    orgBoatKey: async () => null,
  };
  for (const harness of ["claude", "codex"] as const) {
    const resolved = await resolveCredentials(reader, encryptionKey, {
      userId: "user",
      orgId: "org",
      harness,
      credentialId: "account",
    });
    expect(resolved.binding?.credentialId).toBe("account");
    expect(resolved.files).toEqual([]);
    if (harness === "claude") {
      configureClaudeEndpoint(resolved.env);
      expect(resolved.env.ANTHROPIC_BASE_URL).toBe("https://api.morphllm.com");
      expect(resolved.env.ANTHROPIC_API_KEY).toBe("morph_test_key");
      expect(resolved.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(resolved.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("morph-kimik31");
      expect(resolved.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("morph-dsv41flash");
      expect(resolved.env[CLAUDE_ENDPOINT_ENV]).toBeUndefined();
    } else {
      expect(resolved.env.OPENAI_API_KEY).toBe("morph_test_key");
      expect(JSON.parse(resolved.env[CODEX_ENDPOINT_ENV]!)).toEqual({
        version: 1,
        baseUrl: "https://api.morphllm.com/v1",
      });
    }
  }
});
