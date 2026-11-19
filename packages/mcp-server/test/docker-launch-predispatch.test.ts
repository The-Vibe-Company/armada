import { expect, test } from "bun:test";
import type { LaunchCredentialResolver, Sql } from "@armada/core";
import type { LaunchInput } from "@armada/core/contract";
import { apiFailureCode } from "../src/api-failure.ts";
import { createDockerNormalLaunch } from "../src/docker-normal-launch.ts";

test("a pre-dispatch dependency failure is definite and logs a safe reason", async () => {
  const messages: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args);
  };
  let error: unknown;
  try {
    const sql: Sql = { query: async () => ({ rows: [] }) };
    const launch = createDockerNormalLaunch(sql, "", {
      officialImage: `ghcr.io/the-vibe-company/armada-sandbox@sha256:${"a".repeat(64)}`,
      credentials: {
        defaults: async () => {
          throw new Error("private_database_diagnostic");
        },
      } as unknown as LaunchCredentialResolver,
    });
    await launch.launch(
      {
        userId: "11111111-1111-4111-8111-111111111111",
        via: "service",
        orgs: [{ orgId: "22222222-2222-4222-8222-222222222222", role: "admin" }],
      },
      {
        provider: "docker",
        harness: "codex",
        hostId: "44444444-4444-4444-8444-444444444444",
        org: "22222222-2222-4222-8222-222222222222",
        requestId: "33333333-3333-4333-8333-333333333333",
      } satisfies LaunchInput,
    );
  } catch (caught) {
    error = caught;
  } finally {
    console.warn = warn;
  }
  expect(apiFailureCode(error)).toBe("dependency_unavailable");
  expect(String(error)).toContain("account_defaults");
  expect(JSON.stringify(messages)).toContain('"reason":"account_defaults"');
  expect(JSON.stringify(messages)).not.toContain("private_database_diagnostic");
});
