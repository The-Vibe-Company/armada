import { describe, expect, spyOn, test } from "bun:test";
import { ProviderError } from "@armada/core";
import {
  GoldenCreateService,
  type GoldenRecord,
  OUTPUT_COLLECTOR,
  OUTPUT_COLLECTOR_PROBE,
  OUTPUT_COLLECTOR_PROBE_MARKER,
  scanGoldenSandbox,
} from "@armada/core/server";
import { SandboxLastSnapshotStatusEnum, StopOperationStatusEnum } from "@boatdev/sdk";
import { createBoatProvider } from "../src/provider.ts";
import { errorBody, fakeBoat, KEY, retainedSandbox, sandbox } from "./support.ts";

const ID = "bx_23456789";

describe("golden and snapshots", () => {
  test("createGolden starts a blank sandbox with an explicit TTL, labels and an idempotency key", async () => {
    const boat = fakeBoat({ status: 202, body: { ok: true, type: "sandbox.created", sandbox: sandbox() } });
    const info = await boat.provider.createGolden({
      name: "web-golden",
      labels: { armada: "1" },
      idempotencyKey: "key-1",
    });
    const [request] = boat.requests;
    expect(request).toMatchObject({ method: "POST", path: "/api/v1/sandboxes" });
    expect(request?.body).toEqual({ ttlSeconds: 3600, noEnv: true, name: "web-golden", labels: { armada: "1" } });
    expect(request?.body).not.toHaveProperty("env");
    expect(request?.body).not.toHaveProperty("environment");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request?.headers.get("idempotency-key")).toBe("key-1");
    expect(info).toMatchObject({ id: ID, state: "starting", providerState: "provisioning", labels: { armada: "1" } });
    expect(info.expiresAt).toEqual(new Date("2026-11-09T10:00:00Z"));
  });

  test("snapshot saves a saved snapshot, getSnapshot reads its status and deleteSnapshot removes it", async () => {
    const saved = {
      snapshotId: "underlying-artifact",
      name: "web-golden",
      status: "saving",
      sourceSandboxId: ID,
      createdAt: "2026-11-09T09:05:00Z",
    };
    const boat = fakeBoat(
      { status: 202, body: { ok: true, type: "snapshot.saved.saving", status: "saving", snapshot: saved } },
      { body: { ok: true, type: "snapshot.saved.info", snapshot: { ...saved, status: "failed", error: "disk full" } } },
      { body: { ok: true, type: "snapshot.saved.deleted" } },
    );
    expect(await boat.provider.snapshot({ sandboxId: ID, name: "web-golden" })).toMatchObject({
      name: "web-golden",
      artifactId: "underlying-artifact",
      status: "saving",
      sourceSandboxId: ID,
    });
    expect(await boat.provider.getSnapshot("web-golden")).toMatchObject({ status: "failed", error: "disk full" });
    await boat.provider.deleteSnapshot("web-golden");
    expect(boat.requests.map((r) => [r.method, r.path])).toEqual([
      ["POST", "/api/v1/saved-snapshots"],
      ["GET", "/api/v1/saved-snapshots/web-golden"],
      ["DELETE", "/api/v1/saved-snapshots/web-golden"],
    ]);
    expect(boat.requests[0]?.body).toEqual({ sandboxId: ID, name: "web-golden" });
  });

  test.each(["success", "persist-failure"])(
    "secure rebuild uses the SDK-returned saved handle, not request label or disk ID (%s)",
    async (outcome) => {
      const reference = "provider-revision-123";
      const saved = { name: reference, status: "saving", sourceSandboxId: ID, createdAt: "2026-11-09T09:05:00Z" };
      const replies = [
        { status: 202, body: { ok: true, type: "sandbox.created", sandbox: sandbox() } },
        { status: 202, body: { ok: true, type: "snapshot.saved.saving", status: "saving", snapshot: saved } },
        {
          body: {
            ok: true,
            type: "snapshot.saved.info",
            snapshot: { ...saved, status: "ready", snapshotId: "disk-artifact-456" },
          },
        },
        ...(outcome === "persist-failure" ? [{ body: { ok: true, type: "snapshot.saved.deleted" } }] : []),
        { body: { ok: true } },
      ];
      const boat = fakeBoat(...replies);
      let persisted = "";
      const service = new GoldenCreateService({
        authorize: async () => ({
          repos: [{ owner: "acme", repo: "web", id: 1, installationId: 2 }],
          token: "unused-test-token",
        }),
        ssh: async () => {},
        scan: async () => {},
        canDiscardSnapshot: async () => true,
        persist: async (input) => {
          persisted = input.snapshot;
          if (outcome === "persist-failure") throw new Error("injected persistence failure");
        },
      });
      const operation = service.create(
        boat.provider,
        { orgId: "org", userId: "owner", role: "admin" },
        {
          name: "web",
          visibility: "private",
          repos: ["acme/web"],
          existingGolden: {
            id: "logical-golden",
            orgId: "org",
            ownerId: "owner",
            name: "web",
            visibility: "private",
            provider: "boat",
            providerSnapshotId: "last-good",
          } as GoldenRecord,
        },
        { sleep: async () => {} },
      );
      if (outcome === "success") expect((await operation).snapshot).toBe(reference);
      else await expect(operation).rejects.toMatchObject({ code: "build_failed" });
      expect(persisted).toBe(reference);
      expect(boat.requests[1]?.body).toMatchObject({
        sandboxId: ID,
        name: expect.stringMatching(/^golden-r-[a-f0-9-]+$/),
      });
      expect(boat.requests.map(({ method, path }) => [method, path])).toEqual([
        ["POST", "/api/v1/sandboxes"],
        ["POST", "/api/v1/saved-snapshots"],
        ["GET", "/api/v1/saved-snapshots/" + reference],
        ...(outcome === "persist-failure" ? [["DELETE", "/api/v1/saved-snapshots/" + reference]] : []),
        ["POST", "/api/v1/sandboxes/" + ID + "/stop"],
      ]);
      expect(boat.remaining()).toBe(0);
    },
  );

  test("fork starts from the snapshot with the TTL and the credentials as the sandbox's own env", async () => {
    const boat = fakeBoat(
      { status: 202, body: { ok: true, type: "sandbox.created", sandbox: sandbox() } },
      { status: 202, body: { ok: true, type: "sandbox.created", sandbox: sandbox() } },
    );
    await boat.provider.fork({ from: "web-golden", env: { ANTHROPIC_API_KEY: "sk-fake" }, ttlSeconds: 7200 });
    await boat.provider.fork({ from: "web-golden" });
    expect(boat.requests[0]).toMatchObject({ method: "POST", path: "/api/v1/sandboxes" });
    expect(boat.requests[0]?.body).toEqual({
      from: "web-golden",
      ttlSeconds: 7200,
      env: { ANTHROPIC_API_KEY: "sk-fake" },
    });
    expect(boat.requests[1]?.body).toEqual({ from: "web-golden", ttlSeconds: 3600 });
  });

  test.each([
    ["small", "small"],
    ["medium", "default"],
    ["large", "large"],
    ["xlarge", "xlarge"],
  ] as const)("fork size %s sends native Boat type %s without changing the source", async (size, type) => {
    const boat = fakeBoat({ status: 202, body: { ok: true, type: "sandbox.created", sandbox: sandbox() } });
    await boat.provider.fork({ from: "web-golden", size });
    expect(boat.requests).toHaveLength(1);
    expect(boat.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/sandboxes",
      body: { from: "web-golden", type },
    });
  });

  test("invalid size is refused before a Boat allocation request", async () => {
    const boat = fakeBoat();
    await expect(boat.provider.fork({ from: "g", size: "default" as never })).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
    expect(boat.requests).toHaveLength(0);
  });

  test("fork can refuse the account environment and still pass Armada's own env", async () => {
    const boat = fakeBoat({ status: 202, body: { ok: true, type: "sandbox.created", sandbox: sandbox() } });
    await boat.provider.fork({
      from: "web-golden",
      noEnv: true,
      env: { ANTHROPIC_API_KEY: "sk-fake" },
    });
    expect(boat.requests[0]?.body).toEqual({
      from: "web-golden",
      ttlSeconds: 3600,
      noEnv: true,
      env: { ANTHROPIC_API_KEY: "sk-fake" },
    });
  });

  test.each([0, -5, 1.5, 2_592_001])("a TTL of %p is refused before any request", async (ttlSeconds) => {
    const boat = fakeBoat();
    const error = await boat.provider.fork({ from: "g", ttlSeconds }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "invalid_request", retryable: false });
    expect(boat.requests).toHaveLength(0);
  });
});

describe("sandboxes", () => {
  test.each([
    ["verification during the current stop", "2026-11-21T19:42:24Z", 1795290158322, null, undefined, "usable"],
    ["an earlier checkpoint and a normal stop", "2026-11-21T19:42:35Z", 1795290158322, null, false, "usable"],
    [
      "an earlier checkpoint and ambiguous stop mode",
      "2026-11-21T19:42:35Z",
      1795290158322,
      null,
      undefined,
      "unconfirmed",
    ],
    [
      "a forced stop even with verification during the stop",
      "2026-11-21T19:42:24Z",
      1795290158322,
      null,
      true,
      "unconfirmed",
    ],
    ["a request timestamp after the stop ended", "2026-11-21T19:42:39Z", 1795290158322, null, false, "unconfirmed"],
    ["a previous completed stop", "2026-11-21T19:42:24Z", 1795290150657, null, false, "unconfirmed"],
    ["a newer snapshot attempt", "2026-11-21T19:42:24Z", 1795290158322, "2026-11-21T19:42:35Z", false, "unconfirmed"],
  ])(
    "get checks archived retention with %s",
    async (_name, requestedAt, endedAt, lastSnapshotAttemptAt, forced, expected) => {
      const stop = {
        id: "stop-1",
        status: StopOperationStatusEnum.Completed,
        endedAt: new Date(endedAt).toISOString(),
        lastAttemptAt: new Date(endedAt).toISOString(),
        error: null,
      };
      const boat = fakeBoat(
        {
          body: {
            sandbox: retainedSandbox({
              stoppedAt: new Date(1795290158322).toISOString(),
              snapshotVerifiedAt: new Date(1795290150656).toISOString(),
              lastSnapshotAttemptAt,
              lastSnapshotStatus: SandboxLastSnapshotStatusEnum.Completed,
              stop: { ...stop, requestedAt: null },
            }),
          },
        },
        { body: { ok: true, type: "stop.status", id: ID, stop: { ...stop, requestedAt, forced } } },
      );
      expect(await boat.provider.get(ID)).toMatchObject({ state: "stopped", retainedSnapshot: expected });
    },
  );

  test("get identifies a by-ID stop completion mismatch in the retention diagnostic", async () => {
    const stop = {
      id: "stop-1",
      status: StopOperationStatusEnum.Completed,
      endedAt: "2026-11-22T09:03:40Z",
    };
    const verifiedAt = "2026-11-22T09:03:35.500Z";
    const observedEndedAt = "2026-11-22T09:03:41Z";
    const boat = fakeBoat(
      {
        body: {
          sandbox: retainedSandbox({
            stoppedAt: stop.endedAt,
            snapshotVerifiedAt: verifiedAt,
            lastSnapshotStatus: SandboxLastSnapshotStatusEnum.Completed,
            stop,
          }),
        },
      },
      {
        body: {
          ok: true,
          type: "stop.status",
          id: ID,
          stop: { ...stop, endedAt: observedEndedAt, requestedAt: "2026-11-22T09:03:30Z", error: "PRIVATE_ERROR" },
        },
      },
    );
    const log = spyOn(console, "info");
    try {
      expect(await boat.provider.get(ID)).toMatchObject({ state: "stopped", retainedSnapshot: "unconfirmed" });
      const events = log.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(events.find((event) => event.event === "boat_retention_unconfirmed")).toMatchObject({
        providerSandboxId: ID,
        retention: "unconfirmed",
        reason: "stop_end_mismatch",
        verifiedAt: Date.parse(verifiedAt),
        stopEndedAt: Date.parse(stop.endedAt),
        observedStopEndedAt: Date.parse(observedEndedAt),
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_ERROR");
    } finally {
      log.mockRestore();
    }
  });

  test.each([
    {
      name: "a completed stop with a recently verified snapshot",
      stopStatus: StopOperationStatusEnum.Completed,
      snapshot: { lastSnapshotStatus: SandboxLastSnapshotStatusEnum.Completed },
      expected: "usable",
    },
    {
      name: "a superseded prior stop with a recently verified snapshot",
      stopStatus: StopOperationStatusEnum.Superseded,
      snapshot: { lastSnapshotStatus: SandboxLastSnapshotStatusEnum.Completed },
      expected: "usable",
    },
    {
      name: "an in-flight stop",
      stopStatus: StopOperationStatusEnum.Failing,
      snapshot: { lastSnapshotStatus: SandboxLastSnapshotStatusEnum.Completed },
      expected: "pending",
    },
    {
      name: "a snapshot still in progress",
      stopStatus: StopOperationStatusEnum.Completed,
      snapshot: { lastSnapshotStatus: SandboxLastSnapshotStatusEnum.InProgress },
      expected: "pending",
    },
    {
      name: "a failed snapshot attempt despite recent verification",
      stopStatus: StopOperationStatusEnum.Completed,
      snapshot: { lastSnapshotStatus: SandboxLastSnapshotStatusEnum.Failed },
      expected: "unconfirmed",
    },
    {
      name: "no snapshot",
      stopStatus: StopOperationStatusEnum.Completed,
      snapshot: { lastSnapshotStatus: null, snapshotAvailable: false, snapshotVerifiedAt: null },
      expected: "unconfirmed",
    },
  ])("get classifies archived retention with $name", async ({ stopStatus, snapshot, expected }) => {
    const ended = stopStatus === StopOperationStatusEnum.Completed || stopStatus === StopOperationStatusEnum.Superseded;
    const boat = fakeBoat({
      body: {
        ok: true,
        type: "sandbox.info",
        sandbox: retainedSandbox({
          ...snapshot,
          stop: {
            id: "stop-1",
            status: stopStatus,
            requestedAt: ended ? null : "2026-11-09T09:59:00Z",
            lastAttemptAt: "2026-11-09T10:00:00Z",
            endedAt: ended ? "2026-11-09T10:00:00Z" : null,
            error: ended ? null : "archival attempt failed",
          },
        }),
      },
    });
    expect(await boat.provider.get(ID)).toMatchObject({ state: "stopped", retainedSnapshot: expected });
  });

  test("get maps boat's states onto the common ones", async () => {
    const states = [
      "init",
      "cloning",
      "ready",
      "idle",
      "running",
      "archiving",
      "archived",
      "error",
      "cancelled",
      "new",
    ];
    const boat = fakeBoat(
      ...states.map((state) => ({ body: { ok: true, type: "sandbox.info", sandbox: sandbox({ state }) } })),
    );
    const seen: string[] = [];
    for (const _ of states) seen.push((await boat.provider.get(ID)).state);
    expect(seen).toEqual([
      "starting",
      "starting",
      "ready",
      "ready",
      "running",
      "stopping",
      "stopped",
      "failed",
      "failed",
      "starting",
    ]);
  });

  test("get rejects mismatched or missing sandbox identities before accepting a fresh observation", async () => {
    const boat = fakeBoat(
      { body: { ok: true, type: "sandbox.info", sandbox: sandbox({ id: "bx_98765432", state: "archived" }) } },
      { body: { ok: true, type: "sandbox.info", sandbox: sandbox({ id: "" }) } },
      { body: { ok: true, type: "sandbox.info", sandbox: sandbox({ state: "running" }) } },
    );
    for (let i = 0; i < 2; i++)
      await expect(boat.provider.get(ID)).rejects.toMatchObject({
        provider: "boat",
        code: "unknown",
        retryable: false,
      });
    expect(await boat.provider.get(ID)).toMatchObject({ id: ID, state: "running" });
    expect(boat.requests.map((request) => request.method)).toEqual(["GET", "GET", "GET"]);
  });

  test("get reports the ssh endpoint when the machine has no public IPv4", async () => {
    const boat = fakeBoat({
      body: {
        ok: true,
        type: "sandbox.info",
        sandbox: sandbox({ state: "idle", sshEndpoint: "ssh.example:2222" }),
      },
    });
    expect(await boat.provider.get(ID)).toMatchObject({ state: "ready", sshEndpoint: "ssh.example:2222" });
  });

  for (const acknowledgement of ["wrong_identity", "missing_expiry", "missing_sandbox"] as const) {
    test(`lifetime extension verifies the requested sandbox after ${acknowledgement}`, async () => {
      const actual = "2026-11-12T12:00:00Z";
      const reply =
        acknowledgement === "missing_sandbox"
          ? { ok: true }
          : {
              ok: true,
              sandbox: sandbox({
                id: acknowledgement === "wrong_identity" ? "bx_98765432" : ID,
                archiveAfter: acknowledgement === "missing_expiry" ? undefined : "2026-12-01T12:00:00Z",
              }),
            };
      const boat = fakeBoat(
        { body: { ok: true, sandbox: sandbox({ state: "running" }) } },
        { body: reply },
        { body: { ok: true, sandbox: sandbox({ state: "running", archiveAfter: actual }) } },
      );
      if (!boat.provider.extendLifetime) throw Error("Missing Boat lifetime extension support");
      expect(await boat.provider.extendLifetime({ sandboxId: ID, ttlSeconds: 3600 })).toEqual(new Date(actual));
      expect(boat.requests.map(({ method }) => method)).toEqual(["GET", "PATCH", "GET"]);
    });
  }

  test("lifetime extension refuses unrelated observations without replaying the update", async () => {
    const boat = fakeBoat(
      { body: { ok: true, sandbox: sandbox({ id: "bx_98765432", state: "running" }) } },
      { body: { ok: true, sandbox: sandbox({ state: "running" }) } },
      { body: { ok: true } },
      { body: { ok: true, sandbox: sandbox({ id: "bx_98765432", state: "running" }) } },
    );
    if (!boat.provider.extendLifetime) throw Error("Missing Boat lifetime extension support");
    await expect(boat.provider.extendLifetime({ sandboxId: ID, ttlSeconds: 3600 })).rejects.toMatchObject({
      code: "unknown",
    });
    expect(boat.requests.map(({ method }) => method)).toEqual(["GET"]);
    await expect(boat.provider.extendLifetime({ sandboxId: ID, ttlSeconds: 3600 })).rejects.toMatchObject({
      code: "unknown",
    });
    expect(boat.requests.map(({ method }) => method)).toEqual(["GET", "GET", "PATCH", "GET"]);
  });

  test("stop and delete use their endpoints, and delete confirms with the exact sandbox id", async () => {
    const boat = fakeBoat(
      { status: 202, body: { ok: true, type: "sandbox.stopping", id: ID, status: "stopping" } },
      {
        status: 202,
        body: {
          ok: true,
          type: "sandbox.deleting",
          operation: { id: "del_1", kind: "sandbox", targetId: ID, status: "pending", attemptCount: 0 },
        },
      },
    );
    await boat.provider.stop({ sandboxId: ID });
    expect(await boat.provider.delete({ sandboxId: ID })).toEqual({ operationId: "del_1", status: "pending" });
    expect(boat.requests[0]).toMatchObject({ method: "POST", path: `/api/v1/sandboxes/${ID}/stop` });
    expect(boat.requests[1]).toMatchObject({ method: "DELETE", path: `/api/v1/sandboxes/${ID}` });
    expect(boat.requests[1]?.headers.get("x-ascii-confirm-delete")).toBe(ID);
  });
});

describe("exec", () => {
  const finished = {
    body: {
      ok: true,
      type: "command.finished",
      success: true,
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      timedOut: false,
      stdoutTruncated: true,
    },
  };

  test("a synchronous command returns its output and a detached one its process id", async () => {
    const boat = fakeBoat(finished, {
      body: {
        ok: true,
        type: "command.started",
        success: true,
        processId: 7,
        pid: 99,
        command: "sleep 1",
        startedAt: "2026-11-09T09:00:00Z",
      },
    });
    expect(await boat.provider.exec({ sandboxId: ID, command: "echo hi", cwd: "/work", timeoutSeconds: 60 })).toEqual({
      detached: false,
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      timedOut: false,
      truncated: true,
    });
    expect(await boat.provider.exec({ sandboxId: ID, command: "sleep 1", detached: true })).toEqual({
      detached: true,
      processId: 7,
    });
    expect(boat.requests[0]).toMatchObject({ method: "POST", path: `/api/v1/sandboxes/${ID}/commands` });
    expect(boat.requests[0]?.body).toEqual({ command: "echo hi", cwd: "/work", timeoutSeconds: 60 });
    expect(boat.requests[1]?.body).toEqual({ command: "sleep 1", detached: true });
  });

  test("a command refused while the disk is restoring never ran, so it is sent again after a wait", async () => {
    const restoring = errorBody(502, "sandbox_direct_failed", "sandbox_restoring", {
      retryable: true,
      message: "sandbox_restoring",
    });
    const boat = fakeBoat(restoring, restoring, finished);
    const result = await boat.provider.exec({ sandboxId: ID, command: "git pull" });
    expect(result).toMatchObject({ detached: false, exitCode: 0 });
    expect(boat.requests).toHaveLength(3);
    expect(boat.sleeps).toEqual([2000, 2000]);
  });

  test("a command that may have run is never sent again, and a restoring sandbox gives up after five tries", async () => {
    const mayHaveRun = errorBody(502, "sandbox_direct_failed", "connection reset", {
      retryable: true,
      message: "connection reset",
    });
    const first = fakeBoat(mayHaveRun, finished);
    await expect(first.provider.exec({ sandboxId: ID, command: "make" })).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    expect(first.requests).toHaveLength(1);

    const restoring = errorBody(502, "sandbox_direct_failed", "sandbox_restoring", {
      retryable: true,
      message: "sandbox_restoring",
    });
    const stuck = fakeBoat(restoring, restoring, restoring, restoring, restoring, finished);
    await expect(stuck.provider.exec({ sandboxId: ID, command: "make" })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(stuck.requests).toHaveLength(5);
    expect(stuck.remaining()).toBe(1);
  });
});

test("Claude steers natively, Codex by restarting its turn, and neither can ask for approval", () => {
  const { capabilities } = createBoatProvider({ apiKey: "masked" });
  expect(capabilities.claude).toMatchObject({ steer: "in-place", approvals: false, resume: true });
  expect(capabilities.codex).toMatchObject({ steer: "restart", approvals: false, resume: true });
});

test("Boat supports one independent golden", () => {
  expect(createBoatProvider({ apiKey: "masked" }).maxGoldens).toBe(1);
});

test("maps GET /me to a non-secret backend identity", async () => {
  const provider = createBoatProvider({
    apiKey: "masked",
    fetch: (async (input: string | URL | Request) => {
      expect(String(input)).toContain("/me");
      return Response.json({ ok: true, type: "user.info", user: { id: "account_123", email: "private@example.test" } });
    }) as unknown as typeof fetch,
  });
  expect(await provider.backendIdentity?.()).toEqual({ id: "account_123" });
});

// Contract source: @boatdev/sdk 1.13.0 CommandRequest and Boat's public
// POST /sandboxes/{sandboxId}/commands OpenAPI (integer, minimum 1, maximum 600).
test("the real golden scan passes Boat's command timeout validation", async () => {
  let calls = 0;
  const provider = createBoatProvider({
    apiKey: KEY,
    fetch: (async (_input, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      if (!Number.isInteger(body.timeoutSeconds) || body.timeoutSeconds < 1 || body.timeoutSeconds > 600)
        return Response.json({ error: { code: "invalid_timeout", message: "Invalid timeout" } }, { status: 400 });
      return Response.json({
        ok: true,
        type: "command.finished",
        success: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      });
    }) as typeof fetch,
  });
  await scanGoldenSandbox(provider, ID);
  expect(calls).toBe(1);
});

test("resource collection uses bounded fixed file reads, boot fencing and no commands or telemetry writes", async () => {
  // Synthetic protocol response, not real provider utilization evidence.
  const boot = "00000000-0000-0000-0000-000000000001";
  const data: [string, string][] = [
    ["/proc/sys/kernel/random/boot_id", boot],
    ["/proc/uptime", "10.00 0"],
    ["/proc/stat", "cpu 10 0 10 80 0 0 0 0 0 0\ncpu0 10 0 10 80 0 0 0 0 0 0\n"],
    ["/proc/meminfo", "MemTotal: 4096 kB\nMemAvailable: 2048 kB\n"],
    ["/proc/pressure/cpu", "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"],
    ["/proc/vmstat", "oom_kill 0\n"],
    ["/proc/uptime", "10.01 0"],
    ["/proc/sys/kernel/random/boot_id", boot],
  ];
  const state = { body: { ok: true, sandbox: sandbox({ state: "ready" }) } };
  const boat = fakeBoat(
    state,
    ...data.map(([path, content]) => ({
      body: {
        ok: true,
        success: true,
        type: "file.read",
        path,
        content,
        size: content?.length,
        encoding: "utf8",
      },
    })),
    state,
  );
  const observation = await boat.provider.observeResources?.(ID);
  expect(observation).toMatchObject({
    generation: boot,
    physicalId: `${ID}/${boot}`,
    runtimeProvenance: "boat-dedicated-vm",
    reading: { cpuBusyTicks: 20, memoryAvailableBytes: 2097152 },
  });
  expect(boat.requests.every((request) => request.method === "GET")).toBe(true);
  expect(boat.requests.slice(1, -1).map((request) => request.query.get("path"))).toEqual(data.map(([path]) => path));
  const stopped = fakeBoat({ body: { ok: true, sandbox: sandbox({ state: "stopped" }) } });
  expect(await stopped.provider.observeResources?.(ID)).toBeNull();
  expect(stopped.requests).toHaveLength(1);
});

test("starting compute waits for readiness before a command", async () => {
  const boat = fakeBoat(
    { body: { ok: true, sandbox: sandbox({ state: "provisioning" }) } },
    { body: { ok: true, sandbox: sandbox({ state: "ready" }) } },
    {
      body: { ok: true, type: "command.finished", success: true, exitCode: 0, stdout: "", stderr: "", timedOut: false },
    },
  );
  await boat.provider.exec({ sandboxId: ID, command: "capture", onlyIfRunning: true });
  expect(boat.sleeps).toEqual([1000]);
  expect(boat.requests.map((r) => r.method)).toEqual(["GET", "GET", "POST"]);
});

test.each(["exhausted", "stopped", "ambiguous"])("capture retry refuses %s Boat execution safely", async (outcome) => {
  const ready = { body: { ok: true, sandbox: sandbox({ state: "ready" }) } };
  const refused = errorBody(409, "sandbox_not_ready", "Not ready");
  const replies =
    outcome === "exhausted"
      ? Array.from({ length: 5 }, () => [ready, refused]).flat()
      : outcome === "stopped"
        ? [ready, refused, { body: { ok: true, sandbox: sandbox({ state: "archived" }) } }]
        : [ready, errorBody(502, "boat_direct_failed", "Command may have run")];
  const boat = fakeBoat(...replies);
  await expect(boat.provider.exec({ sandboxId: ID, command: "capture", onlyIfRunning: true })).rejects.toMatchObject({
    code: outcome === "ambiguous" ? "unavailable" : "sandbox_not_ready",
    status: outcome === "stopped" ? undefined : outcome === "exhausted" ? 409 : 502,
  });
  expect(boat.requests.filter((r) => r.path.endsWith("/commands"))).toHaveLength(outcome === "exhausted" ? 5 : 1);
  expect(boat.sleeps).toHaveLength(outcome === "exhausted" ? 4 : outcome === "stopped" ? 1 : 0);
  expect(boat.requests.some((r) => r.path.endsWith("/resume") || r.path.endsWith("/stop"))).toBe(false);
});

test("capture cancellation during a readiness wait cannot admit a later command", async () => {
  const controller = new AbortController();
  const paths: string[] = [];
  const provider = createBoatProvider({
    apiKey: KEY,
    sleep: async () => {
      controller.abort();
    },
    fetch: (async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return path.endsWith("/commands")
        ? Response.json(errorBody(409, "sandbox_not_ready", "Not ready").body, { status: 409 })
        : Response.json({ ok: true, sandbox: sandbox({ state: "ready" }) });
    }) as typeof fetch,
  });
  await expect(
    provider.exec({ sandboxId: ID, command: "capture", onlyIfRunning: true, signal: controller.signal }),
  ).rejects.toBeDefined();
  expect(paths).toEqual([`/api/v1/sandboxes/${ID}`, `/api/v1/sandboxes/${ID}/commands`]);
});

test("runtime activation resumes compute with explicit lifetime and no account environment or native inference", async () => {
  const boat = fakeBoat({ body: { ok: true } }, { body: { ok: true, sandbox: sandbox({ state: "running" }) } });
  await boat.provider.resumeRuntime(ID, 1200);
  expect(boat.requests.map(({ method, path }) => [method, path])).toEqual([
    ["POST", `/api/v1/sandboxes/${ID}/resume`],
    ["GET", `/api/v1/sandboxes/${ID}`],
  ]);
  expect(boat.requests[0]?.body).toEqual({ noEnv: true, env: {}, ttlSeconds: 1200 });
  await expect(boat.provider.resumeRuntime(ID, 1.5)).rejects.toBeDefined();
  expect(boat.requests).toHaveLength(2);
});

test("declared outputs are read from live compute by the fixed collector and never resume a stopped sandbox", async () => {
  const stdout = JSON.stringify([{ name: "final.pdf", base64: Buffer.from("final").toString("base64") }]);
  const live = fakeBoat(
    { body: { ok: true, sandbox: sandbox({ state: "ready" }) } },
    { body: { ok: true, type: "command.finished", success: true, exitCode: 0, stdout, stderr: "", timedOut: false } },
  );
  const read = await live.provider.readOutputs?.({ sandboxId: ID });
  expect(read?.map((file) => [file.name, Buffer.from(file.bytes).toString()])).toEqual([["final.pdf", "final"]]);
  expect((live.requests.at(-1)?.body as { command?: string } | undefined)?.command).toBe(OUTPUT_COLLECTOR);
  // A stopped sandbox is refused, never resumed: its retained disk is outside this read.
  const stopped = fakeBoat({ body: { ok: true, sandbox: sandbox({ state: "archived" }) } });
  expect(await stopped.provider.readOutputs?.({ sandboxId: ID })).toBeNull();
  expect(stopped.requests.map((r) => r.method)).toEqual(["GET"]);
  expect(stopped.remaining()).toBe(0);
});

test("the capability probe treats a Bun that exits 0 without the probe answer as unsupported", async () => {
  const reply = (stdout: string) =>
    fakeBoat(
      { body: { ok: true, sandbox: sandbox({ state: "ready" }) } },
      { body: { ok: true, type: "command.finished", success: true, exitCode: 0, stdout, stderr: "", timedOut: false } },
    );
  const ready = reply(`${OUTPUT_COLLECTOR_PROBE_MARKER}\n`);
  expect(await ready.provider.probeOutputs?.({ sandboxId: ID })).toBe(true);
  expect((ready.requests.at(-1)?.body as { command?: string } | undefined)?.command).toBe(OUTPUT_COLLECTOR_PROBE);
  await expect(reply("Bun CLI help\n").provider.probeOutputs?.({ sandboxId: ID })).rejects.toMatchObject({
    reason: "collector_unsupported",
  });
});

test("managed Boat forks use the configured deployment label", async () => {
  const deploymentId = "production:armada-server";
  const deploymentLabel = "armada.deployment";
  const boat = fakeBoat({ status: 202, body: { sandbox: sandbox() } });
  const provider = createBoatProvider({ apiKey: KEY, deploymentId, fetch: boat.fetch });
  await provider.fork({ from: "golden", labels: { armada: "sandbox", [deploymentLabel]: "foreign" } });
  const labels = (boat.requests[0]?.body as { labels: Record<string, string> } | undefined)?.labels ?? {};
  expect(labels[deploymentLabel]).toBe("e1baae800b32c14f86d994e54558a11aeee43726be9481e54a25ef67195f11f7");
});
