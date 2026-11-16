import { expect, test } from "bun:test";
import type { Provider, Sql } from "@armada/core/server";
import { createGitHubRuntime } from "../src/github-runtime.ts";

test("GitHub preparation propagates authority lookup failures instead of silently omitting helpers", async () => {
  const failure = new Error("authority_lookup_failed");
  const runtime = createGitHubRuntime({
    sql: {
      query: async () => {
        throw failure;
      },
      transaction: async () => {
        throw new Error("unexpected_transaction");
      },
    } as Sql,
    github: {
      encryptionKey: undefined,
      store: {} as Parameters<typeof createGitHubRuntime>[0]["github"]["store"],
      app: { clientId: "offline", clientSecret: "offline" },
    },
    origin: "https://armada.example",
    providerForSandbox: async () => {
      throw new Error("unexpected_provider_lookup");
    },
  });
  await expect(runtime.prepare({ id: "modal" } as Provider, "sandbox")).rejects.toBe(failure);
});
