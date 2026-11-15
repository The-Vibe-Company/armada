import { expect, test } from "bun:test";
import { type CredentialReader, resolveCredentials } from "../src/credentials.ts";
import { encryptSecret } from "../src/crypto.ts";

// Personal per-agent billing selection must override old account-wide defaults, not explicit pins.
test("per-agent selections are independent and explicit account pins still win", async () => {
  const key = Buffer.alloc(32, 13).toString("base64");
  const valueEnc = await encryptSecret("account_value", key);
  const reader: CredentialReader = {
    agentDefaults: async () => [
      { harness: "claude", credentialId: "shared_account", model: null },
      { harness: "codex", credentialId: "codex_account", model: null },
    ],
    credentials: async (scope) =>
      scope === "org"
        ? []
        : [
            { id: "shared_account", kind: "morph", valueEnc, version: 1, isDefault: true },
            { id: "codex_account", kind: "openai", valueEnc, version: 1 },
          ],
    orgBoatKey: async () => null,
  };
  for (const [harness, credentialId, expected] of [
    ["claude", undefined, "shared_account"],
    ["codex", undefined, "codex_account"],
    ["codex", "shared_account", "shared_account"],
  ] as const) {
    const result = await resolveCredentials(reader, key, {
      userId: "user",
      orgId: "org",
      harness,
      ...(credentialId ? { credentialId } : {}),
    });
    expect(result.binding?.credentialId).toBe(expected);
  }
});

test("an unavailable personal default refuses instead of silently changing billing", async () => {
  const key = Buffer.alloc(32, 13).toString("base64");
  const reader: CredentialReader = {
    agentDefaults: async () => [{ harness: "codex", credentialId: "removed_account", model: null }],
    credentials: async () => [
      { id: "other_account", kind: "openai", valueEnc: await encryptSecret("other_value", key), isDefault: true },
    ],
    orgBoatKey: async () => null,
  };
  await expect(resolveCredentials(reader, key, { userId: "user", orgId: "org", harness: "codex" })).rejects.toThrow(
    /No Codex credential/,
  );
});
