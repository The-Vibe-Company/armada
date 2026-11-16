import { expect, test } from "bun:test";
import { type CredentialReader, resolveCredentials } from "../src/credentials.ts";
import { encryptSecret } from "../src/crypto.ts";

type StoredCredential = Awaited<ReturnType<CredentialReader["credentials"]>>[number];

const key = Buffer.alloc(32, 13).toString("base64");

test("implicit selection ignores deleted accounts for ambiguity, defaults and scope fallback", async () => {
  const valueEnc = await encryptSecret("account_value", key);
  const active: StoredCredential = { id: "remaining", kind: "openai", valueEnc, status: "active", version: 2 };
  const deleted: StoredCredential = { ...active, id: "removed", status: "deleted" };
  for (const scope of ["user", "org"] as const) {
    for (const isDefault of [false, true]) {
      const reader: CredentialReader = {
        credentials: async (requested) => (requested === scope ? [{ ...deleted, isDefault }, active] : []),
        orgBoatKey: async () => null,
      };
      const result = await resolveCredentials(reader, key, { userId: "user", orgId: "org", harness: "codex" });
      expect(result.binding).toEqual({ credentialId: "remaining", credentialVersion: 2 });
      expect(result.sources).toEqual([{ kind: "openai", scope }]);
    }
  }
  const reader: CredentialReader = {
    credentials: async (scope) => (scope === "user" ? [deleted] : [active]),
    orgBoatKey: async () => null,
  };
  expect((await resolveCredentials(reader, key, { userId: "user", orgId: "org", harness: "codex" })).sources).toEqual([
    { kind: "openai", scope: "org" },
  ]);
});

test("deleted explicit and saved accounts refuse without falling back", async () => {
  const valueEnc = await encryptSecret("account_value", key);
  for (const saved of [false, true]) {
    const reader: CredentialReader = {
      agentDefaults: async () => [{ harness: "codex", credentialId: "removed", model: null }],
      credentials: async () => [
        { id: "removed", kind: "openai", valueEnc, status: "deleted", version: 2 },
        { id: "remaining", kind: "openai", valueEnc, status: "active", isDefault: true },
      ],
      orgBoatKey: async () => null,
    };
    await expect(
      resolveCredentials(reader, key, {
        userId: "user",
        orgId: "org",
        harness: "codex",
        ...(saved ? {} : { credentialId: "removed", credentialVersion: 2 }),
      }),
    ).rejects.toMatchObject({ code: "credential_refused" });
  }
});
