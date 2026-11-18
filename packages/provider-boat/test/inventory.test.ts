import { expect, test } from "bun:test";
import { createBoatProvider } from "../src/provider.ts";
import { fakeBoat, KEY, sandbox } from "./support.ts";

test("Boat inventory uses the deployment label on managed forks and rechecks scope across pages", async () => {
  const deploymentId = "production:armada-server";
  const deploymentLabel = "armada.deployment";
  const boat = fakeBoat({ status: 202, body: { sandbox: sandbox() } });
  const provider = createBoatProvider({ apiKey: KEY, deploymentId, fetch: boat.fetch });
  await provider.fork({ from: "golden", labels: { armada: "sandbox", [deploymentLabel]: "foreign" } });
  const labels = (boat.requests[0]?.body as { labels: Record<string, string> } | undefined)?.labels ?? {};
  expect(labels[deploymentLabel]).toMatch(/^[a-f0-9]{64}$/);

  const owned = sandbox({ labels, machineProvider: "hetzner" });
  const listing = fakeBoat(
    {
      body: {
        sandboxes: [
          { ...owned, id: "foreign", labels: { ...labels, [deploymentLabel]: "foreign" } },
          { ...owned, id: "owner-manual", labels: {} },
          { ...owned, id: "stopped", machineProvider: null },
          { ...owned, id: "invalid-time", createdAt: "invalid" },
        ],
        pageInfo: { hasMore: true, nextCursor: "page-two" },
      },
    },
    { body: { sandboxes: [owned], pageInfo: { hasMore: false, nextCursor: null } } },
  );
  const inventory = createBoatProvider({ apiKey: KEY, deploymentId, fetch: listing.fetch });
  const first = await inventory.listSandboxInventory();
  expect(first).toEqual({ items: [], cursor: "page-two" });
  expect(await inventory.listSandboxInventory({ cursor: "page-two" })).toEqual({
    items: [{ sandboxId: "bx_23456789", deploymentId, createdAt: new Date("2026-11-09T09:00:00Z") }],
    cursor: null,
  });
  expect(listing.requests.map((request) => [request.query.get("label"), request.query.get("cursor")])).toEqual([
    [`${deploymentLabel}=${labels[deploymentLabel]}`, null],
    [`${deploymentLabel}=${labels[deploymentLabel]}`, "page-two"],
  ]);
});

test("Boat inventory makes no account-wide request when the deployment is unbound", async () => {
  const boat = fakeBoat();
  expect(await boat.provider.listSandboxInventory()).toEqual({ items: [], cursor: null });
  expect(boat.requests).toHaveLength(0);
});
