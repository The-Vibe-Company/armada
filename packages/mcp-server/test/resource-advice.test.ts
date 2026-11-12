import { expect, test } from "bun:test";
import {
  type ProviderResourceObservation,
  type ResourceAdviceResponse,
  type ResourceProject,
  SIZED_LAUNCH_TOOL_V1,
} from "@armada/core";
import { createSqlVaultStore } from "@armada/core/server";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { call, ENCRYPTION_KEY, harness, PUBLIC_URL } from "./support.ts";

test("API/MCP collect genuine-path bounded samples, pin project identity and abstain without complete workload evidence", async () => {
  const server = await harness();
  try {
    const token = await server.token(server.people.owner);
    const client = await server.client(token);
    const launched = await call(client, SIZED_LAUNCH_TOOL_V1, {
      size_policy_version: 1,
      golden: "shared",
      org: server.people.org,
      harness: "claude",
      repo: "web",
      size: "small",
    });
    expect(launched.isError).toBe(false);
    const id = launched.data.id as string;
    const row = (
      await server.db.query<{ resource_project: ResourceProject | null; provider_sandbox_id: string }>(
        "select resource_project,provider_sandbox_id from sandboxes where id=$1",
        [id],
      )
    ).rows[0];
    if (!row) throw Error("missing launch");
    expect(row.resource_project).toMatchObject({ version: 1, dir: "web", url: "https://github.com/example/web.git" });
    let collected = 0,
      fail = false,
      partial = false;
    // Synthetic transport counters only, never claimed as real provider utilization.
    server.boat.provider.observeResources = async (providerSandboxId): Promise<ProviderResourceObservation> => {
      if (fail) throw Error("collector unavailable");
      collected++;
      return {
        version: 1,
        providerSandboxId,
        physicalId: "vm-1",
        generation: "boot-1",
        scope: "dedicated-vm",
        runtimeProvenance: "boat-dedicated-vm",
        limitations: ["sampled-memory-not-peak", "hypervisor-throttling-unavailable"],
        reading: {
          version: 1,
          bootId: "00000000-0000-0000-0000-000000000001",
          uptimeMs: collected * 10000,
          captureDurationMs: 10,
          cpuLogicalCpus: partial ? null : 2,
          cpuTotalTicks: collected * 1000,
          cpuBusyTicks: collected * 100,
          cpuStealTicks: 0,
          memoryTotalBytes: 4 * 1024 ** 3,
          memoryAvailableBytes: 3 * 1024 ** 3,
          cpuPressureSomeUsec: (collected - 1) * 1000000,
          oomKills: 0,
        },
      };
    };
    const control = {
      authStore: server.auth,
      supabase: { supabaseUrl: "https://unused.test", anonKey: "test" },
      store: createSqlVaultStore(server.db),
      encryptionKey: ENCRYPTION_KEY,
      data: createSqlData(server.db),
      providers: { resolve: async () => server.boat.provider },
      now: () => server.clock.now,
    };
    const http = async (bearer = token) => {
      const response = await handleControlRequest(
        new Request(`${PUBLIC_URL}/api/v1/sandbox/advice`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}` },
          body: JSON.stringify({ id }),
        }),
        control,
      );
      if (!response) throw Error("missing route");
      return response;
    };
    const first = await http();
    expect(first.status).toBe(200);
    const body = (await first.json()) as ResourceAdviceResponse;
    expect(body.advice).toMatchObject({
      version: 1,
      reason: "insufficient_coverage",
      recommendedSize: null,
      window: { considered: 1, sufficient: 0 },
      sampled: { points: 1, intervals: 0 },
      observations: { memoryPeakBytes: null, activeSeconds: null },
    });
    const same = await call(client, "resource_advice", { id });
    expect(same.isError).toBe(false);
    expect(same.data.advice).toEqual(body.advice);
    expect(collected).toBe(1);
    server.clock.now = new Date(server.clock.now.getTime() + 10000);
    const concurrent = await Promise.all([http(), http()]);
    expect(concurrent.map((r) => r.status)).toEqual([200, 200]);
    expect(collected).toBe(2);
    const second = (await (await http()).json()) as ResourceAdviceResponse;
    expect(second.advice.sampled).toMatchObject({
      points: 2,
      intervals: 1,
      allActivityCpuAverageBusyCores: 0.2,
      memoryMaxObservedBytes: 1024 ** 3,
      oomKills: 0,
    });
    expect(second.advice.observations.cpuAverageBusyCores).toBeNull();
    expect(second.advice.reason).toBe("resource_pressure");
    await expect(server.db.query("update sandboxes set resource_project=null where id=$1", [id])).rejects.toThrow(
      "immutable",
    );
    await server.db.query("update goldens set config=$1::jsonb where name='shared'", [
      JSON.stringify({ repos: [{ url: "https://github.com/acme/other.git", branch: "main", dir: "web" }], init: [] }),
    ]);
    expect(((await (await http()).json()) as ResourceAdviceResponse).advice.scope.project).toEqual(
      row.resource_project,
    );
    const memberToken = await server.token(server.people.member);
    const member = await server.client(memberToken);
    const list = await call(member, "list");
    const metadata = (list.data.sandboxes as Record<string, unknown>[]).find((row) => row.id === id);
    expect(metadata).toMatchObject({ id, canOpen: false, machineSize: "small" });
    expect(metadata).not.toHaveProperty("resourceProject");
    expect(JSON.stringify(metadata)).not.toContain(row.resource_project!.url);
    expect((await http(memberToken)).status).toBe(404);
    expect((await call(member, "resource_advice", { id })).isError).toBe(true);
    expect(collected).toBe(2);
    expect((await http(await server.token(server.people.admin))).status).toBe(200);
    expect(collected).toBe(2);
    partial = true;
    server.clock.now = new Date(server.clock.now.getTime() + 10000);
    expect((await http()).status).toBe(200);
    fail = true;
    server.clock.now = new Date(server.clock.now.getTime() + 10000);
    expect((await http()).status).toBe(200);
    expect(
      (await server.db.query<{ count: number }>("select count(*)::integer as count from resource_observations")).rows[0]
        ?.count,
    ).toBe(2);
  } finally {
    await server.close();
  }
});
