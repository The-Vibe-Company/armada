import { afterAll, beforeAll, expect, test } from "bun:test";
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

test("MCP allocation before failed registration returns a recoverable handle and fences replay", async () => {
  const { db, people } = fixture;
  const sql = bunLikeSql(db);
  const caller = {
    via: "service" as const,
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
  };
  const data = createSqlData(sql)(caller);
  const boat = fakeBoat();
  let allocations = 0;
  let logical = "";
  boat.provider.list = async () => ({ items: [boat.sandbox("bx_1").info], cursor: null });
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
  const input = { golden: "shared", harness: "claude", idempotencyKey: "mcp-uncertainty-key" };
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
  const receipt = await callSharedTool(context, "launch_receipt", { id: logical, golden: "shared" });
  expect(receipt).toMatchObject({
    id: logical,
    outcome: "unknown",
    allocations: [{ id: expect.any(String), state: expect.any(String) }],
  });
  boat.provider.fork = async (request) => {
    allocations++;
    return fork(request);
  };
  const successInput = { ...input, idempotencyKey: "mcp-lost-success-key" };
  const first = await callSharedTool(context, "launch", successInput);
  expect(await callSharedTool(context, "launch", successInput)).toEqual(first);
  expect(allocations).toBe(2);
});
