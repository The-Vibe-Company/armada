// External infrastructure only. Actual serve/provider/MCP/authority code consumes
// this SDK and its local protocol1 tunnel; no business handler/factory is replaced.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Machine } from "@armada/provider-modal";
import { catalogLock } from "./skillpack-catalog.ts";

type Grant = { token: string; generation: string; sandboxId: string };
type Vm = {
  expectedMcp: number;
  id: string;
  name: string;
  tags: Record<string, string>;
  exit: number | null;
  grant?: Grant;
  epoch: boolean;
  mcp: boolean;
  prompts?: Map<string, { promptId: string; conversationId: string; status: "finished"; done: true }>;
};
export function fakeModalRuntime(input: {
  appName: string;
  appId: string;
  tokenId: string;
  tokenSecret: string;
  skillRevision: string;
  legacy(): Machine;
  scope(): string;
}) {
  const effects = {
    allocations: 0,
    allocationAttempts: 0,
    terminations: 0,
    runnerCalls: 0,
    modelCalls: 0,
    promptCalls: 0,
    skillLaunchOrder: [] as string[],
    mcpConfigurations: 0,
    epochInstalls: 0,
  };
  const byId = new Map<string, Vm>(),
    byName = new Map<string, Vm>();
  let providerReads = 0;
  const privateTokens = new Set<string>();
  let expectedMcp = 0;
  let preservationFailure = "missing_python3";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const kernel = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const id = new URL(request.url).pathname.slice(1);
      const vm = byId.get(id);
      assert(vm?.grant, "Unbootstrapped fake tunnel.");
      assert(request.headers.get("x-armada-runner-grant") === vm.grant.token, "Wrong private generation grant.");
      assert(request.headers.get("authorization") === "Bearer synthetic-connect", "Wrong connect token.");
      const packet = (await request.json()) as {
        version: number;
        requestId: string;
        op: string;
        promptId?: string;
        input?: { command?: string; conversationId?: string };
        configuration?: { revision: string; servers: object };
        token?: string;
      };
      effects.runnerCalls++;
      if (packet.op === "exec" && packet.input?.command?.includes("git rev-parse --git-path info/exclude"))
        effects.skillLaunchOrder.push("exclude");
      if (packet.op === "exec" && packet.input?.command?.startsWith("skillpack install"))
        effects.skillLaunchOrder.push("install");
      if (packet.op === "prompt") {
        effects.promptCalls++;
        effects.skillLaunchOrder.push("prompt");
      }
      const capturing = packet.op === "exec" && packet.input?.command?.includes("ARMADA_RECOVERY");
      if (capturing && preservationFailure === "unavailable") return new Response(null, { status: 503 });
      let result: unknown;
      if (packet.op === "health") result = { generation: vm.grant.generation, ready: true };
      else if (packet.op === "exec")
        result = {
          detached: false,
          exitCode: packet.input?.command?.includes("example/missing") ? 1 : 0,
          stdout: packet.input?.command?.includes("ARMADA_RECOVERY")
            ? preservationFailure === "output_invalid"
              ? "not-json"
              : JSON.stringify({ status: "failed", reason: preservationFailure })
            : packet.input?.command?.startsWith("skillpack install")
              ? catalogLock("codex")
              : "",
          stderr: "",
          timedOut: !!capturing && preservationFailure === "timeout",
          truncated: !!capturing && preservationFailure === "output_truncated",
        };
      else if (packet.op === "configureMcp") {
        assert(!vm.epoch, "Generic MCP must prepare before private epoch installation.");
        assert(packet.configuration);
        assert.equal(
          Object.keys(packet.configuration.servers).length,
          vm.expectedMcp,
          "Managed MCP connection selection changed.",
        );
        for (const server of Object.values(packet.configuration.servers) as {
          headers?: { Authorization?: string };
        }[]) {
          const capability = server.headers?.Authorization?.slice(7);
          if (capability) privateTokens.add(capability);
        }
        vm.mcp = true;
        effects.mcpConfigurations++;
        result = { revision: packet.configuration.revision };
      } else if (packet.op === "installOrchestratorEpoch") {
        assert(vm.expectedMcp === 0 || vm.mcp, "Managed external/default MCP was silently skipped.");
        assert(packet.token && /^armada_epoch_[a-f0-9]{64}$/.test(packet.token));
        privateTokens.add(packet.token);
        vm.epoch = true;
        effects.epochInstalls++;
        result = { acknowledged: true };
      } else if (packet.op === "scrubOrchestratorEpoch") {
        vm.epoch = false;
        result = { acknowledged: true };
      } else if (packet.op === "observeOrchestrator")
        result = {
          physicalGeneration: vm.grant.generation,
          state: "quiescent",
          evidence: "native-fixture-observation",
          eventWatermark: 0,
          acknowledgedSequence: 0,
          nativeSessionId: null,
        };
      else if (packet.op === "interrupt") result = {};
      else if (packet.op === "steer") return Response.json({ error: "no_running_turn" }, { status: 409 });
      else if (packet.op === "prompt") {
        const accepted = {
          promptId: crypto.randomUUID(),
          conversationId: packet.input?.conversationId ?? crypto.randomUUID(),
          status: "finished" as const,
          done: true as const,
        };
        vm.prompts ??= new Map();
        vm.prompts.set(accepted.promptId, accepted);
        result = accepted;
      } else if (packet.op === "getPrompt") {
        result = vm.prompts?.get(packet.promptId ?? "");
        assert(result, "Only accepted fixture prompt ids can be read");
      } else if (packet.op === "events") result = { events: [], hasMore: false };
      else if (packet.op === "checkpoint")
        result = { generation: vm.grant.generation, watermark: 0, acknowledgedSequence: 0 };
      else {
        effects.modelCalls++;
        throw Error("Unexpected model/native-conversation RPC.");
      }
      return Response.json({ version: 1, requestId: packet.requestId, result });
    },
  });
  const localOrigin = `http://127.0.0.1:${kernel.port}`;
  const tunnelOrigin = "https://synthetic-modal-tunnel.invalid";
  function sandbox(vm: Vm) {
    return {
      sandboxId: vm.id,
      poll: async () => vm.exit,
      getTags: async () => vm.tags,
      terminate: async () => {
        effects.terminations++;
        vm.exit = 0;
      },
      createConnectToken: async () => ({ url: `${tunnelOrigin}/${vm.id}`, token: "synthetic-connect" }),
      snapshotFilesystem: async () => ({ imageId: `im_snapshot_${vm.id}` }),
      exec: async () => {
        let packet: Record<string, unknown> | undefined;
        return {
          stdin: {
            writeText: async (text: string) => {
              packet = JSON.parse(text) as Record<string, unknown>;
              if (packet.grant) vm.grant = packet.grant as Grant;
            },
            close: async () => {},
          },
          wait: async () => 0,
          stdout: {
            readText: async () => {
              if (typeof packet?.bundle === "string")
                return `ARMADA_RUNTIME_INSTALLED ${createHash("sha256").update(Buffer.from(packet.bundle, "base64")).digest("hex")}`;
              if (packet?.op === "capture")
                return JSON.stringify({
                  version: 1,
                  physicalId: packet.physicalId,
                  generation: packet.generation,
                  namespace: { pid: "pid:[fixture]", mount: "mnt:[fixture]" },
                  processes: [{ pid: 1, start: "1" }],
                });
              return "";
            },
          },
        };
      },
    };
  }
  function legacy() {
    const row = input.legacy();
    let vm = byId.get(row.physicalId!);
    if (!vm) {
      vm = {
        id: row.physicalId!,
        name: row.physicalName,
        tags: { armada_sandbox: row.info.id, armada_scope: input.scope(), armada_generation: "1" },
        exit: null,
        epoch: false,
        mcp: false,
        expectedMcp: 0,
      };
      byId.set(vm.id, vm);
      byName.set(vm.name, vm);
    }
    return vm;
  }
  class Client {
    constructor(options: { tokenId: string; tokenSecret: string }) {
      assert(
        options.tokenId === input.tokenId && options.tokenSecret === input.tokenSecret,
        "Wrong management authority.",
      );
    }
    apps = {
      fromName: async (name: string, options: object) => {
        providerReads++;
        assert.equal(name, input.appName);
        assert.deepEqual(options, { environment: "main", createIfMissing: false });
        return { appId: input.appId };
      },
    };
    images = { fromId: async (imageId: string) => ({ imageId }), delete: async () => {} };
    sandboxes = {
      create: async (
        _app: unknown,
        _image: unknown,
        options: { name: string; tags: Record<string, string>; env: object; secrets: unknown[] },
      ) => {
        effects.allocationAttempts++;
        await gate;
        assert.deepEqual(options.env, {});
        assert.deepEqual(options.secrets, []);
        const vm: Vm = {
          id: `sb_${crypto.randomUUID()}`,
          name: options.name,
          tags: options.tags,
          exit: null,
          epoch: false,
          mcp: false,
          expectedMcp,
        };
        byId.set(vm.id, vm);
        byName.set(vm.name, vm);
        effects.allocations++;
        return sandbox(vm);
      },
      fromId: async (id: string) => {
        const vm = byId.get(id);
        assert(vm, "Unknown physical identity.");
        return sandbox(vm);
      },
      fromName: async (name: string, physicalName: string, options: object) => {
        assert.equal(name, input.appName);
        assert.deepEqual(options, { environment: "main", includeTerminated: true });
        legacy();
        const vm = byName.get(physicalName);
        assert(vm, "Unknown physical name.");
        return sandbox(vm);
      },
    };
    close() {}
  }
  return {
    failPreservation(reason: string) {
      preservationFailure = reason;
    },
    Client,
    effects,
    localOrigin,
    tunnelOrigin,
    privateTokens,
    release,
    expectConnections: (count: number) => {
      expectedMcp = count;
    },
    providerReads: () => providerReads,
    close: () => kernel.stop(true),
  };
}
