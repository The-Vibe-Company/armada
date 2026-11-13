import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "@armada/core";
import { createDockerHostRoutes } from "../src/docker-host-routes.ts";
import { createDockerHostStore } from "../src/docker-host-store.ts";
import { migratedDatabase } from "./migrated-database.ts";

// HTTP owns bearer separation, bounded shape admission and cache/error policy.
// SQL authority/replay/durability contracts remain owned by docker-host-store.test.ts.
test("opt-in host HTTP routes separate user and host capabilities and never cache or echo private input", async () => {
  const db = await migratedDatabase();
  try {
    const userId = randomUUID(),
      orgId = randomUUID(),
      installationId = randomUUID();
    await db.query("insert into auth.users(id) values($1)", [userId]);
    await db.query("insert into orgs(id,name) values($1,'HTTP host fixture')", [orgId]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [orgId, userId]);
    const sql: Sql = {
      query: (q, p) => db.query(q, p),
      transaction: (work) => db.transaction((tx) => work({ query: (q, p) => tx.query(q, p) })),
    };
    const route = createDockerHostRoutes(
      createDockerHostStore(sql, Buffer.alloc(32, 8).toString("base64")),
      async (request) =>
        request.headers.get("authorization") === "Bearer fixture-user-token"
          ? { ok: true, caller: { userId, orgs: [{ orgId, role: "admin" }], via: "service" } }
          : { ok: false },
    );
    async function post(path: string, token: string, body: unknown, extra: Record<string, string> = {}) {
      const response = await route(
        new Request(`https://staging.example${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
          body: JSON.stringify(body),
        }),
      );
      expect(response).not.toBeNull();
      expect(response!.headers.get("cache-control")).toBe("no-store");
      return response!;
    }
    const ticketResponse = await post("/api/v1/docker/hosts/register-token", "fixture-user-token", { org: orgId });
    expect(ticketResponse.status).toBe(200);
    const ticket = (await ticketResponse.json()) as { hostId: string; registrationToken: string };
    const registered = await post("/api/docker-host/register", ticket.registrationToken, { installationId });
    expect(registered.status).toBe(200);
    const host = (await registered.json()) as { hostId: string; hostToken: string };
    expect(host.hostId).toBe(ticket.hostId);
    expect((await post("/api/docker-host/poll", host.hostToken, { installationId })).status).toBe(200);
    expect((await post("/api/v1/docker/hosts/register-token", host.hostToken, { org: orgId })).status).toBe(401);
    expect((await post("/api/docker-host/poll", "fixture-user-token", { installationId })).status).toBe(401);
    expect((await post("/api/docker-host/poll", host.hostToken, { installationId, unexpected: true })).status).toBe(
      400,
    );
    expect(
      (await post("/api/docker-host/poll", host.hostToken, { installationId }, { origin: "https://foreign.example" }))
        .status,
    ).toBe(400);
    const expiry = { installationId, requestId: randomUUID(), expired: true };
    // Exact expiry packets reach machine authorization; ambiguous/nonliteral
    // packets are rejected by HTTP before any machine fact can be recorded.
    expect((await post("/api/docker-host/results", host.hostToken, expiry)).status).toBe(401);
    for (const body of [
      { ...expiry, expired: false },
      { ...expiry, expired: "true" },
      { ...expiry, outcome: "completed" },
      { ...expiry, extra: true },
    ])
      expect((await post("/api/docker-host/results", host.hostToken, body)).status).toBe(400);
    const denied = await post("/api/docker-host/results", host.hostToken, {
      installationId,
      requestId: randomUUID(),
      outcome: "completed",
    });
    expect(denied.status).toBe(401);
    const deniedText = await denied.text();
    expect(deniedText.includes(host.hostToken)).toBe(false);
    expect(deniedText.includes(ticket.registrationToken)).toBe(false);
    expect(
      (await post("/api/v1/docker/hosts/revoke", "fixture-user-token", { org: orgId, hostId: host.hostId })).status,
    ).toBe(200);
    expect((await post("/api/docker-host/poll", host.hostToken, { installationId })).status).toBe(401);
    expect((await route(new Request("https://staging.example/api/docker-host/poll")))?.status).toBe(405);
    expect(await route(new Request("https://staging.example/unrelated"))).toBeNull();
  } finally {
    await db.close();
  }
});
