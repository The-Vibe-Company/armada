import { expect, test } from "bun:test";
import { createMemoryAuthStore } from "@armada/auth";
import { createSqlVaultStore, decryptSecret, type Sql, type VaultStore } from "@armada/core/server";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createGitHubRuntime } from "../src/github-runtime.ts";

test("control maps oversized JSON to 413 while preserving parser errors and valid auth.json uploads", async () => {
  const userId = crypto.randomUUID();
  const writes: { userId: string; valueEnc: Uint8Array<ArrayBuffer> | undefined }[] = [];
  // The SQL store owns persistence; ingress keeps real encryption and inspects its store-bound bytes.
  const store: Pick<VaultStore, "memberships" | "mutateAccount"> = {
    async memberships() {
      return [];
    },
    async mutateAccount(userId, _input, valueEnc) {
      writes.push({ userId, valueEnc: valueEnc?.slice() });
      return { kind: "codex_auth", createdAt: null };
    },
  };

  const key = Buffer.alloc(32, 5).toString("base64");
  const options: ControlOptions = {
    authStore: createMemoryAuthStore(),
    supabase: {
      supabaseUrl: "https://supabase.test",
      anonKey: "anon",
      fetch: async () => Response.json({ id: userId }),
    },
    store: store as VaultStore,
    encryptionKey: key,
  };
  const send = (route: string, body: string) =>
    handleControlRequest(
      new Request(`https://armada.test/api/v1/${route}`, {
        method: "POST",
        headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" },
        body,
      }),
      options,
    );
  for (const route of [
    "org/list",
    "auth/exchange",
    "auth/email/start",
    "auth/email/verify",
    "auth/refresh",
    "token/create",
    "token/revoke",
  ]) {
    const response = await send(route, JSON.stringify({ value: "é".repeat(65536) }));
    expect(response?.status).toBe(413);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toEqual({ error: { code: "invalid", message: "The request is too large." } });
  }
  const malformed = await send("org/list", "{");
  expect(malformed?.status).toBe(400);
  expect(await malformed?.json()).toEqual({ error: { code: "invalid", message: "The request is not JSON." } });
  expect((await send("org/list", ""))?.status).toBe(200);
  const value = JSON.stringify({ padding: "x".repeat(65000) });
  expect((await send("creds/accounts/set", JSON.stringify({ scope: "user", kind: "codex_auth", value })))?.status).toBe(
    200,
  );
  expect(writes).toHaveLength(1);
  const written = writes[0];
  if (!written?.valueEnc) throw new Error("Credential did not reach the account store");
  expect(written.userId).toBe(userId);
  expect(await decryptSecret(written.valueEnc, key)).toBe(value);
});

test("private broker keeps oversized input indistinguishable from other denials", async () => {
  const sql: Sql = {
    async query<T>() {
      return { rows: [{ sandbox_id: "unused", binding: { githubApp: "offline" } }] as T[] };
    },
  };
  const runtime = createGitHubRuntime({
    sql,
    github: {
      encryptionKey: undefined,
      app: { clientId: "offline", clientSecret: "offline" },
      store: createSqlVaultStore(sql),
    },
    origin: "https://armada.test",
    providerForSandbox: async () => {
      throw new Error("Must not reach provider");
    },
  });
  for (const body of ["x".repeat(1025), "{"]) {
    const response = await runtime.route(
      new Request("https://armada.test/api/internal/github/credentials", {
        method: "POST",
        headers: { authorization: `Bearer armada_gh_${"a".repeat(64)}` },
        body,
      }),
    );
    expect(response?.status).toBe(403);
    expect(await response?.text()).toBe("");
    expect(response?.headers.get("cache-control")).toBe("no-store");
  }
});
