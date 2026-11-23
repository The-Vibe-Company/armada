import { afterAll, beforeAll, expect, test } from "bun:test";
import { launchEnvelope } from "@armada/core/contract";
import { createSqlVaultStore } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { withBoatManagementIdentity } from "../src/observed-boat.ts";
import { createOrdinaryLaunchReceipts } from "../src/ordinary-launch-receipts.ts";
import { callSharedTool } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";
import { enrolledLaunchPolicy } from "./launch-runtime.fixture.ts";
import { bunLikeSql, database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

let prepared: Promise<Awaited<ReturnType<typeof database>>> | undefined;
beforeAll(async () => {
  prepared = database();
  await prepared;
});
afterAll(async () => {
  const pending = prepared;
  prepared = undefined;
  await pending?.then(
    ({ db }) => db.close(),
    () => undefined,
  );
});

test("MCP allocation before failed registration returns a receipt ID and fences replay", async () => {
  const fixture = await prepared;
  if (!fixture) throw Error("Launch recovery database is not open");
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
  const fork = boat.provider.fork.bind(boat.provider);
  boat.provider.fork = async (request) => {
    allocations++;
    logical = request.labels?.sandbox ?? "";
    await fork(request);
    throw Error("provider allocated, response lost");
  };
  const credentials = launchCredentials(createSqlVaultStore(sql), ENCRYPTION_KEY);
  const context = {
    caller,
    data,
    provider: async () => {
      throw Error("Launch must use the selected runtime placement");
    },
    // The raw launch host gains management provenance from the runtime placement.
    launch: {
      boatRuntimeDefault: {
        policy: enrolledLaunchPolicy(sql),
        provider: async () => withBoatManagementIdentity(boat.provider, "org", people.org),
        connections: { async validate() {}, async bind() {} },
        credentials,
      },
    },
    launchCredentials: credentials,
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
  delete context.launch;
  expect(await callSharedTool(context, "launch", successInput)).toEqual(first);

  await db.query("update ordinary_launch_receipts set response=$1::jsonb where request_key=$2", [
    JSON.stringify({ id: first.sandbox.id, provider: "boat", golden: "shared" }),
    successInput.idempotencyKey,
  ]);
  await expect(callSharedTool(context, "launch", successInput)).rejects.toMatchObject({
    code: "outcome_unknown",
  });
  expect(allocations).toBe(2);
});
