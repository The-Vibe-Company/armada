import { afterAll, beforeAll, expect, test } from "bun:test";
import { launchEnvelope } from "@armada/core/contract";
import { createSqlData } from "../src/data.ts";
import { createOrdinaryLaunchReceipts } from "../src/ordinary-launch-receipts.ts";
import { callSharedTool } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";
import { bunLikeSql, database, fakeBoat } from "./support.ts";

let fixture: Awaited<ReturnType<typeof database>>;
beforeAll(async () => {
  fixture = await database();
});
afterAll(async () => {
  await fixture.db.close();
});

test("MCP allocation before failed registration returns a receipt ID and fences replay", async () => {
  const { db, people } = fixture;
  const sql = bunLikeSql(db);
  const caller = {
    via: "service" as const,
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
  };
  const data = createSqlData(sql)(caller);
  const boat = fakeBoat();
  // Production providerRegistry supplies immutable credential management provenance.
  boat.provider.managementIdentity = async () => ({ scope: "org", ownerId: people.org });
  let allocations = 0;
  let logical = "";
  const fork = boat.provider.fork.bind(boat.provider);
  boat.provider.fork = async (request) => {
    allocations++;
    logical = request.labels?.sandbox ?? "";
    await fork(request);
    throw Error("provider allocated, response lost");
  };
  const context = {
    caller,
    data,
    provider: async () => boat.provider,
    launchCredentials: { resolve: async () => ({ env: {}, secrets: [], codexAuthJson: false }) },
    ordinaryLaunchReceipts: createOrdinaryLaunchReceipts(sql),
    logError: () => {},
  } as unknown as ToolContext;
  const input = { provider: "boat", golden: "shared", harness: "claude", idempotencyKey: "mcp-uncertainty-key" };
  await expect(callSharedTool(context, "launch", input)).rejects.toMatchObject({ code: "outcome_unknown" });
  expect(logical).not.toBe("");
  await expect(callSharedTool(context, "launch", input)).rejects.toMatchObject({
    code: "outcome_unknown",
    message: expect.stringContaining(logical),
  });
  expect(allocations).toBe(1);
  await expect(callSharedTool(context, "launch", { ...input, prompt: "conflict" })).rejects.toMatchObject({
    code: "conflict",
  });
  boat.provider.fork = async (request) => {
    allocations++;
    return fork(request);
  };
  const successInput = { ...input, idempotencyKey: "mcp-lost-success-key" };
  const first = launchEnvelope.parse(await callSharedTool(context, "launch", successInput));
  expect(await callSharedTool(context, "launch", successInput)).toEqual(first);

  // A completion written before the envelope cutover still owns the replay key.
  await db.query("update ordinary_launch_receipts set response=$1::jsonb where request_key=$2", [
    JSON.stringify({ id: first.sandbox.id, provider: "boat", golden: "shared" }),
    successInput.idempotencyKey,
  ]);
  await expect(callSharedTool(context, "launch", successInput)).rejects.toMatchObject({
    code: "outcome_unknown",
  });
  expect(allocations).toBe(2);
});
