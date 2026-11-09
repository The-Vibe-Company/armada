import { describe, expect, test } from "bun:test";
import { ProviderError } from "@armada/core";
import { GoldenCreateService, type GoldenRecord, scanGoldenSandbox } from "@armada/core/server";
import { BOAT_CAPABILITIES, createBoatProvider } from "../src/provider.ts";
import { errorBody, fakeBoat, KEY, sandbox } from "./support.ts";

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
    const saved = { name: "web-golden", status: "saving", sourceSandboxId: ID, createdAt: "2026-11-09T09:05:00Z" };
    const boat = fakeBoat(
      { status: 202, body: { ok: true, type: "snapshot.saved.saving", status: "saving", snapshot: saved } },
      { body: { ok: true, type: "snapshot.saved.info", snapshot: { ...saved, status: "failed", error: "disk full" } } },
      { body: { ok: true, type: "snapshot.saved.deleted" } },
    );
    expect(await boat.provider.snapshot({ sandboxId: ID, name: "web-golden" })).toMatchObject({
      name: "web-golden",
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

describe("native harness cwd preparation", () => {
  test("installs the harness wrapper in the forked VM", async () => {
    const boat = fakeBoat({
      body: { ok: true, type: "command.finished", success: true, exitCode: 0, stdout: "", stderr: "", timedOut: false },
    });
    await boat.provider.prepareNativeHarnessCwd?.({ sandboxId: ID, harness: "codex", cwd: "/work/repo" });
    expect(boat.requests).toHaveLength(1);
    expect(boat.requests[0]).toMatchObject({ method: "POST", path: `/api/v1/sandboxes/${ID}/commands` });
    expect(boat.requests[0]?.body).toMatchObject({ timeoutSeconds: 60 });
    const command = (boat.requests[0]?.body as { command?: string } | undefined)?.command;
    expect(command).toContain("/usr/local/bin/codex");
    expect(command).toContain("/work/repo");
  });

  test("propagates VM preparation failures", async () => {
    const boat = fakeBoat({
      body: {
        ok: true,
        type: "command.finished",
        success: false,
        exitCode: 1,
        stdout: "",
        stderr: "wrapper failed",
        timedOut: false,
      },
    });
    await expect(
      boat.provider.prepareNativeHarnessCwd?.({ sandboxId: ID, harness: "claude", cwd: "/work/repo" }),
    ).rejects.toMatchObject({
      message: "wrapper failed",
    });
  });
});

describe("sandboxes", () => {
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

  test("list filters by labels and states and pages with boat's cursor", async () => {
    const boat = fakeBoat(
      {
        body: {
          ok: true,
          type: "sandbox.list",
          sandboxes: [sandbox({ state: "idle" })],
          pageInfo: { nextCursor: "next-1", hasMore: true, limit: 2 },
        },
      },
      {
        body: {
          ok: true,
          type: "sandbox.list",
          sandboxes: [],
          pageInfo: { nextCursor: null, hasMore: false, limit: 2 },
        },
      },
    );
    const first = await boat.provider.list({
      labels: { armada: "1", owner: "u1" },
      states: ["ready", "running"],
      limit: 2,
    });
    expect(first.cursor).toBe("next-1");
    expect(first.items[0]).toMatchObject({ id: ID, state: "ready" });
    const last = await boat.provider.list({ cursor: first.cursor as string });
    expect(last).toEqual({ items: [], cursor: null });
    const query = boat.requests[0]?.query;
    expect(query?.getAll("label")).toEqual(["armada=1", "owner=u1"]);
    expect(query?.get("state")).toBe("ready,idle,running");
    expect(query?.get("limit")).toBe("2");
    expect(boat.requests[1]?.query.get("cursor")).toBe("next-1");
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

describe("agent turns", () => {
  const queued = (conversationId: string) => ({
    status: 202,
    body: {
      ok: true,
      type: "prompt.queued",
      id: ID,
      promptId: "prompt_1",
      conversationId,
      status: "queued",
      provider: "claude-code",
      promptRun: { id: "prompt_1", promptId: "prompt_1", sandboxId: ID, status: "queued", done: false },
    },
  });

  test("a prompt without a conversation opens a new one on the right harness, with its options", async () => {
    const boat = fakeBoat(queued("conv_new"));
    const receipt = await boat.provider.prompt({
      sandboxId: ID,
      harness: "claude",
      text: "Fix the tests",
      model: "claude-sonnet-5",
      reasoningEffort: "high",
      fast: true,
    });
    expect(receipt).toEqual({ promptId: "prompt_1", conversationId: "conv_new", status: "queued" });
    expect(boat.requests[0]).toMatchObject({ method: "POST", path: `/api/v1/sandboxes/${ID}/prompt` });
    expect(boat.requests[0]?.body).toEqual({
      provider: "claude-code",
      prompt: "Fix the tests",
      new: true,
      model: "claude-sonnet-5",
      reasoningEffort: "high",
      fast: true,
    });
  });

  test("a prompt with a conversation continues it, and codex maps to boat's codex", async () => {
    const boat = fakeBoat(queued("conv_1"));
    await boat.provider.prompt({ sandboxId: ID, harness: "codex", text: "Go on", conversationId: "conv_1" });
    expect(boat.requests[0]?.body).toEqual({ provider: "codex", prompt: "Go on", conversationId: "conv_1" });
  });

  test("an empty prompt is refused before any request", async () => {
    const boat = fakeBoat();
    await expect(boat.provider.prompt({ sandboxId: ID, harness: "claude", text: "  " })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(boat.requests).toHaveLength(0);
  });

  test("getPrompt reads the run's status and whether it is done", async () => {
    const run = { id: "p", promptId: "p", sandboxId: ID, done: true, conversationId: "conv_1" };
    const boat = fakeBoat(
      { body: { ok: true, type: "prompt.run", id: ID, promptRun: { ...run, status: "interrupted" } } },
      { body: { ok: true, type: "prompt.run", id: ID, promptRun: { ...run, status: "teleporting" } } },
    );
    expect(await boat.provider.getPrompt({ sandboxId: ID, promptId: "p" })).toEqual({
      promptId: "p",
      status: "interrupted",
      done: true,
      conversationId: "conv_1",
    });
    expect(boat.requests[0]).toMatchObject({ method: "GET", path: `/api/v1/sandboxes/${ID}/prompts/p` });
    await expect(boat.provider.getPrompt({ sandboxId: ID, promptId: "p" })).rejects.toMatchObject({ code: "unknown" });
  });

  test("steer names its conversation and returns how boat delivered it", async () => {
    const boat = fakeBoat({
      body: {
        ok: true,
        type: "prompt.steered",
        id: ID,
        conversationId: "conv_1",
        promptId: "prompt_1",
        mode: "native",
      },
    });
    expect(await boat.provider.steer({ sandboxId: ID, text: "Skip e2e", conversationId: "conv_1" })).toEqual({
      conversationId: "conv_1",
      promptId: "prompt_1",
      mode: "native",
    });
    expect(boat.requests[0]).toMatchObject({ method: "POST", path: `/api/v1/sandboxes/${ID}/steer` });
    expect(boat.requests[0]?.query.get("conversation")).toBe("conv_1");
    expect(boat.requests[0]?.body).toEqual({ message: "Skip e2e", conversation: "conv_1" });
  });

  test("interrupt scopes to a conversation when one is named, else stops everything", async () => {
    const boat = fakeBoat({ body: { ok: true, type: "x", id: ID, status: "interrupted" } }, { body: { ok: true } });
    await boat.provider.interrupt({ sandboxId: ID, conversationId: "conv_1" });
    await boat.provider.interrupt({ sandboxId: ID });
    expect(boat.requests[0]).toMatchObject({ method: "POST", path: `/api/v1/sandboxes/${ID}/interrupt` });
    expect(boat.requests[0]?.query.get("conversation")).toBe("conv_1");
    expect(boat.requests[1]?.query.has("conversation")).toBe(false);
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
  expect(BOAT_CAPABILITIES.claude).toMatchObject({ steer: "native", approvals: false, resume: true });
  expect(BOAT_CAPABILITIES.codex).toMatchObject({ steer: "restart", approvals: false, resume: true });
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

test("native bootstrap follows actual resume readiness and precedes prompt; I/O failures forbid turns and snapshots", async () => {
  for (const fail of [false, true]) {
    const events: string[] = [];
    let gets = 0;
    const provider = createBoatProvider({
      apiKey: KEY,
      sleep: async () => {},
      fetch: (async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (init?.method === "GET") {
          const state = ["archived", "provisioning", "ready"][gets++] ?? "ready";
          events.push(state);
          return Response.json({ sandbox: sandbox({ state }) });
        }
        if (path.endsWith("/commands")) {
          events.push("bridge");
          return Response.json({
            ok: true,
            type: "command.finished",
            success: true,
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
          });
        }
        if (path.endsWith("/resume")) {
          events.push("resume");
          return Response.json({ ok: true });
        }
        if (path.endsWith("/prompt")) {
          events.push("prompt");
          return Response.json({ promptId: "p", conversationId: "c", status: "queued" });
        }
        throw Error("Unexpected provider HTTP operation");
      }) as typeof fetch,
      beforeResume: async () => {
        events.push("fence");
        return true;
      },
      beforePrompt: async () => {
        events.push("configure");
        if (fail) throw Error("bootstrap I/O failed");
      },
      beforeSnapshot: async () => {
        throw Error("snapshot scrub I/O failed");
      },
    });
    const turn = provider.prompt({
      sandboxId: ID,
      harness: "codex",
      text: "work",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
    });
    if (fail) await expect(turn).rejects.toThrow("bootstrap I/O failed");
    else await turn;
    expect(events).toEqual([
      "archived",
      "fence",
      "resume",
      "provisioning",
      "ready",
      "configure",
      ...(fail ? [] : ["bridge", "prompt"]),
    ]);
    await expect(provider.snapshot({ sandboxId: ID, name: "safe" })).rejects.toThrow("snapshot scrub I/O failed");
  }
});

test("a stopped-only beforeResume hook refuses the provider resume API on fence failure", async () => {
  const methods: string[] = [];
  const provider = createBoatProvider({
    apiKey: KEY,
    beforeResume: async () => {
      throw Error("resume fence denied");
    },
    fetch: (async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json({ sandbox: sandbox({ state: "archived" }) });
    }) as typeof fetch,
  });
  await expect(provider.prompt({ sandboxId: ID, harness: "codex", text: "work" })).rejects.toThrow(
    "resume fence denied",
  );
  expect(methods).toEqual(["GET"]);
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
