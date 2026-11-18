import { expect, test } from "bun:test";
import type { Provider } from "@armada/core/server";
import { createBoatOrchestratorProvider } from "../src/boat-delegated-access-provider.ts";

test("Boat native bridge install removes its own SSH authorization on actual guest scripts", async () => {
  const { spawn: realSpawn } = await import("node:child_process");
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHmac, createHash } = await import("node:crypto");
  const { sshDelegatedReceipt } = await import("@armada/core/server");
  const { boatOrchestratorControlScript } = await import("../src/boat-delegated-access-script.ts");
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
      await sshDelegatedReceipt(
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
