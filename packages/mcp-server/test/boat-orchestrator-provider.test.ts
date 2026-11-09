import { expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Provider, SshExecDeps } from "@armada/core/server";
import { createBoatOrchestratorProvider } from "../src/boat-orchestrator-provider.ts";

test("Boat composition uses pinned stdin for probe/install/scrub and never public exec or token argv/config", async () => {
  const boot = "00000000-0000-4000-8000-000000000001",
    token = `armada_epoch_${"a".repeat(64)}`;
  const argv: string[][] = [],
    payloads: Record<string, unknown>[] = [],
    writes: string[] = [];
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
                  `ARMADA_ORCHESTRATOR_RECEIPT ${Buffer.from(JSON.stringify({ physicalGeneration: boot, acknowledged: true, port: 32100, epoch: String(payload.epoch ?? "1"), authorityInstalled: payload.op !== "scrub" })).toString("base64url")}\n`,
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
  expect(
    await install({
      sandboxId: "fixture",
      token,
      binding: { epoch: "2", physicalGeneration: boot },
      url: "https://armada.invalid/private/mcp",
    }),
  ).toEqual({ acknowledged: true });
  expect(await scrub({ sandboxId: "fixture", physicalGeneration: boot, tokenHash: "a".repeat(64) })).toEqual({
    acknowledged: true,
  });
  const configured = payloads.find((p) => "port" in p);
  expect(configured).toEqual({ boot, port: 32100 });
  expect(JSON.stringify(argv)).not.toContain(token);
  expect(writes.join("")).not.toContain(token);
  expect(argv.some((args) => args.includes("StrictHostKeyChecking=yes"))).toBe(true);
});

test("Boat native bridge install removes its own SSH authorization on actual guest scripts", async () => {
  const { spawn: realSpawn } = await import("node:child_process");
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHmac, createHash } = await import("node:crypto");
  const { sshOrchestratorReceipt } = await import("@armada/core/server");
  const { boatOrchestratorControlScript } = await import("../src/boat-orchestrator-script.ts");
  const home = await mkdtemp(join(tmpdir(), "armada-boat-bridge-"));
  const sandboxId = `synthetic-${crypto.randomUUID()}`;
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const authorized = join(home, ".ssh/authorized_keys"),
    unrelated = "ssh-ed25519 UNRELATED user-key\n";
  await mkdir(join(home, ".ssh"));
  await writeFile(authorized, unrelated, { mode: 0o600 });
  const raw = {
    id: "boat",
    get: async () => ({ state: "ready" }),
    sshKey: async ({ key }: { key: string }) => {
      await writeFile(authorized, `${await readFile(authorized, "utf8")}${key}\n`);
      return { sshEndpoint: "ssh.test:2222", hostKey: "ssh-ed25519 PINNED" };
    },
    exec: async () => {
      throw Error("Public exec forbidden.");
    },
  } as unknown as Provider;
  const run = ((file: string, args: string[], options: Parameters<typeof realSpawn>[2]) =>
    file === "ssh"
      ? realSpawn("bash", ["-c", `bash -c ${args.at(-1)}`], { ...options, env: { ...process.env, HOME: home } })
      : realSpawn(file, args, options)) as typeof realSpawn;
  const deps = { spawn: run };
  const provider = createBoatOrchestratorProvider(raw, "synthetic-server-key", deps);
  try {
    const install = provider.installOrchestratorEpoch;
    if (!install) throw Error("Missing private install.");
    await install({
      sandboxId,
      token: `armada_epoch_${"c".repeat(64)}`,
      binding: { epoch: "1", physicalGeneration: boot },
      url: "https://armada.invalid/private/mcp",
    });
    expect(await readFile(authorized, "utf8")).toBe(unrelated);
    expect(JSON.parse(await readFile(join(home, ".claude.json"), "utf8")).mcpServers.armada_orchestrator.url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/mcp$/,
    );
    // A real configuration conflict still cleans both the control and bridge keys.
    await writeFile(join(home, ".armada/orchestrator-bridge-owned.json"), "conflict");
    await expect(
      install({
        sandboxId,
        token: `armada_epoch_${"d".repeat(64)}`,
        binding: { epoch: "2", physicalGeneration: boot },
        url: "https://armada.invalid/private/mcp",
      }),
    ).rejects.toThrow("orchestrator_private_transport_unavailable");
    expect(await readFile(authorized, "utf8")).toBe(unrelated);
  } finally {
    const control = createHmac("sha256", "synthetic-server-key")
      .update(JSON.stringify(["armada-orchestrator-private-control-v1", sandboxId, boot]))
      .digest("hex");
    for (const op of ["scrub", "shutdown"])
      await sshOrchestratorReceipt(
        raw,
        { sandboxId, token: JSON.stringify({ sandboxId, boot, control, op }), script: boatOrchestratorControlScript },
        deps,
      );
    await rm(
      join(
        "/dev/shm",
        `armada-orchestrator-${process.getuid?.()}`,
        `${createHash("sha256").update(sandboxId).digest("hex").slice(0, 24)}.json`,
      ),
      { force: true },
    );
    await rm(home, { recursive: true, force: true });
  }
});
