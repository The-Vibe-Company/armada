import { expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Provider, SshExecDeps } from "@armada/core/server";
import { createBoatOrchestratorProvider } from "../src/boat-delegated-access-provider.ts";

test("Boat composition uses pinned stdin for probe/install/scrub and never public exec or token argv/config", async () => {
  const boot = "00000000-0000-4000-8000-000000000001",
    token = `armada_epoch_${"a".repeat(64)}`;
  const argv: string[][] = [],
    payloads: Record<string, unknown>[] = [],
    writes: string[] = [];
  let bridgeAcknowledged = true;
  const run = ((file: string, args: string[]) => {
    argv.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: {
        end: (body: string) => {
          queueMicrotask(() => {
            if (file === "ssh") {
              const payload = JSON.parse(body.split("\n")[0] ?? "{}") as Record<string, unknown>;
              payloads.push(payload);
              child.stdout.emit(
                "data",
                Buffer.from(
                  `ARMADA_ORCHESTRATOR_RECEIPT ${Buffer.from(JSON.stringify({ physicalGeneration: boot, acknowledged: !("port" in payload) || bridgeAcknowledged, port: 32100, epoch: String(payload.epoch ?? "1"), authorityInstalled: payload.op !== "scrub" })).toString("base64url")}\n`,
                ),
              );
            }
            child.emit("close", 0);
          });
        },
      },
      kill: () => true,
    });
    return child as unknown as ReturnType<typeof spawn>;
  }) as typeof spawn;
  const deps: SshExecDeps = {
    spawn: run,
    chmod: async () => {},
    writeFile: async (_p, v) => {
      writes.push(String(v));
    },
    readPublicKey: async () => "ssh-ed25519 PUBLIC",
  };
  const raw = {
    id: "boat",
    get: async () => ({ state: "ready" }),
    sshKey: async () => ({ sshEndpoint: "ssh.test:2222", hostKey: "ssh-ed25519 PINNED" }),
    exec: async () => {
      throw Error("Public exec forbidden.");
    },
  } as unknown as Provider;
  const provider = createBoatOrchestratorProvider(raw, "server-fixture-key", deps);
  expect((await provider.get("fixture")).physicalGeneration).toBe(boot);
  const install = provider.installOrchestratorEpoch,
    scrub = provider.scrubOrchestratorEpoch;
  if (!install || !scrub) throw Error("missing private ports");
  const request = {
    sandboxId: "fixture",
    token,
    binding: { epoch: "2", physicalGeneration: boot },
    url: "https://armada.invalid/private/mcp",
  };
  expect(await install(request)).toEqual({ acknowledged: true });
  bridgeAcknowledged = false;
  await expect(install(request)).rejects.toThrow("orchestrator_private_transport_unavailable");
  expect(await scrub({ sandboxId: "fixture", physicalGeneration: boot, tokenHash: "a".repeat(64) })).toEqual({
    acknowledged: true,
  });
  const configured = payloads.find((p) => "port" in p);
  expect(configured).toEqual({ boot, port: 32100 });
  expect(JSON.stringify(argv)).not.toContain(token);
  expect(writes.join("")).not.toContain(token);
  expect(argv.some((args) => args.includes("StrictHostKeyChecking=yes"))).toBe(true);
});
