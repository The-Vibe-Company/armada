import { expect, test } from "bun:test";
import type { Sql } from "../src/golden-store.ts";
import { createSqlVaultStore } from "../src/vault-store.ts";

test("an account missing from the mutation result gives observation guidance", async () => {
  const sql: Sql = {
    query: async <T>(statement: string) => ({
      rows: (statement.includes("for update") ? [{ kind: "anthropic", version: 1 }] : []) as T[],
    }),
    transaction: async (work) => work(sql),
  };
  await expect(
    createSqlVaultStore(sql).mutateAccount!("owner", { scope: "user", id: "account", action: "rename", name: "Work" }),
  ).rejects.toMatchObject({
    code: "unavailable",
    message:
      "The account change could not be verified because the updated account was not returned. Reload the account list before retrying.",
  });
});
