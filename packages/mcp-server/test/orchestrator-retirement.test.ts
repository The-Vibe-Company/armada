import { expect, test } from "bun:test";
import { createSqlVaultStore } from "@armada/core/server";
import { handleControlRequest } from "../src/control.ts";
import { bunLikeSql, harness } from "./support.ts";

test("owner orchestrator prefixes authenticate then return readable removal without a runtime", async () => {
  const s = await harness();
  const options = {
    authStore: s.auth,
    store: createSqlVaultStore(bunLikeSql(s.db)),
    encryptionKey: undefined,
    supabase: { supabaseUrl: "https://supabase.invalid", anonKey: "fixture" },
  };
  const invoke = async (request: Request) => {
    const response = await handleControlRequest(request, options);
    if (!response) throw Error("Tombstone prefix did not match");
    return response;
  };
  try {
    const token = await s.token(s.people.owner);
    for (const suffix of [
      "",
      "/capabilities",
      "/parent",
      "/parent/settings",
      "/parent/waits",
      "/parent/waits/lease/renew",
    ]) {
      const url = `https://armada.test/api/v1/orchestrators${suffix}`;
      const denied = await invoke(new Request(url));
      expect(denied.status).toBe(401);
      for (const method of ["GET", "POST"]) {
        const response = await invoke(new Request(url, { method, headers: { authorization: `Bearer ${token}` } }));
        expect(response.status).toBe(410);
        const body = (await response.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("removed");
        expect(body.error.message).toContain("--armada-access");
        expect(body.error.message).toContain("#1002");
      }
    }
  } finally {
    await s.close();
  }
});
