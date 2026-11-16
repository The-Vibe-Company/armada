import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "@armada/core";
import { createDockerHostRoutes } from "../src/docker-host-routes.ts";
import { createDockerHostStore, DockerHostUnavailable } from "../src/docker-host-store.ts";

test("store failures retain their cause and return sanitized unavailable responses for owners and machines", async () => {
  const cause = Object.assign(new Error("private database detail"), { code: "connection_failed" });
  const sql: Sql = {
    query: async () => {
      throw cause;
    },
    transaction: async () => {
      throw cause;
    },
  };
  const store = createDockerHostStore(sql, Buffer.alloc(32, 8).toString("base64"));
  const userId = randomUUID(),
    orgId = randomUUID();
  await expect(store.list({ userId, orgId })).rejects.toMatchObject({
    name: "DockerHostUnavailable",
    cause,
  });
  const route = createDockerHostRoutes(store, async () => ({
    ok: true as const,
    caller: { userId, orgs: [{ orgId, role: "admin" as const }], via: "supabase" as const },
  }));
  for (const [path, body] of [
    ["/api/v1/docker/hosts/list", { org: orgId }],
    ["/api/docker-host/poll", { installationId: randomUUID() }],
  ] as const) {
    const response = await route(
      new Request(`https://example.test${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${"a".repeat(64)}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: "docker_host_unavailable" });
  }
  expect(new DockerHostUnavailable(cause).cause).toBe(cause);
});
