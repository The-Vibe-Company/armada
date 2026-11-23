import { expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { createControlClient } from "../control";
import { parseSandboxFilters } from "../sandbox-filters";
import type { Database } from "../supabase/types";
import { loadSandboxInventory } from "./sandbox-inventory";

test("the Sandboxes list reads activity once for the organization without per-sandbox controls", async () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({
    id: String(index),
    orgId: "org",
    ownerId: "viewer",
    provider: "modal",
    providerSandboxId: null,
    harness: "codex",
    model: null,
    reasoningEffort: null,
    status: "ready",
    createdAt: "2026-11-23T00:00:00Z",
    stoppedAt: null,
    expiresAt: null,
    effectiveTtlSeconds: null,
    machineSize: null,
    displayLabel: `Sandbox ${index}`,
    canOpen: true,
    canManage: true,
  }));
  const metadataOffsets: number[] = [];
  const supabase = createClient<Database>("https://metadata.test", "placeholder", {
    global: {
      fetch: async (input) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/rest/v1/rpc/sandbox_list_metadata");
        const offset = Number(url.searchParams.get("offset"));
        metadataOffsets.push(offset);
        return Response.json(rows.slice(offset, offset + 500));
      },
    },
  });
  const controlCalls: string[] = [];
  const control = createControlClient({
    serverUrl: "https://armada.test",
    token: "placeholder",
    fetch: async (input, init) => {
      controlCalls.push(new URL(String(input)).pathname);
      expect(JSON.parse(String(init?.body))).toEqual({ org: "org" });
      return Response.json({ "500": "running" });
    },
  });
  const inventory = await loadSandboxInventory(supabase, "org", parseSandboxFilters({}), "viewer", "working", control);
  expect(metadataOffsets).toEqual([0, 500]);
  expect(controlCalls).toEqual(["/api/v1/sandbox/list-turns"]);
  expect(inventory.rows.map(({ id }) => id)).toEqual(["500"]);
});
