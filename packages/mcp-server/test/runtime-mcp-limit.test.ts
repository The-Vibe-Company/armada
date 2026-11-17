import { expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import type { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeMcp } from "../src/runtime-mcp.ts";
import { ENCRYPTION_KEY } from "./support.ts";

test("runtime launch and preflight admit 100 connections to authorization and reject 101 before SQL", async () => {
  const authorization = new Error("authorization_reached");
  let queries = 0;
  const sql: Sql = {
    async query() {
      queries++;
      throw authorization;
    },
  };
  const runtime = createRuntimeMcp({
    sql,
    key: ENCRYPTION_KEY,
    origin: "https://armada.test",
    commands: {} as ReturnType<typeof createRuntimeCommands>,
  });
  const actor = { userId: crypto.randomUUID(), orgId: crypto.randomUUID() };
  const caller = {
    userId: actor.userId,
    via: "service" as const,
    orgs: [{ orgId: actor.orgId, role: "member" as const }],
  };
  const selected = Array.from({ length: 101 }, () => crypto.randomUUID());
  for (const validate of [
    (connections: string[]) => runtime.connections.validate(actor, connections, "private"),
    (connections: string[]) => runtime.preflight(caller, { org: actor.orgId, connections }),
  ]) {
    await expect(validate(selected.slice(0, 100))).rejects.toBe(authorization);
    const before = queries;
    await expect(validate(selected)).rejects.toMatchObject({ code: "invalid" });
    expect(queries).toBe(before);
  }
});
