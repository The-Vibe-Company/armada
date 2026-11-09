import { expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { type Provider, type SshExecDeps, sshOrchestratorReceipt } from "../src/server.ts";

test("private SSH captures only bounded nonsecret receipt, pins host and keeps payload out of argv/files", async () => {
  const token = `armada_epoch_${"a".repeat(64)}`;
  const boot = "00000000-0000-4000-8000-000000000001";
  const calls: { file: string; args: string[]; stdin?: string }[] = [],
    writes: string[] = [];
  const run = ((file: string, args: string[]) => {
    const call = { file, args, stdin: "" };
    calls.push(call);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: {
        end: (value: string) => {
          call.stdin = value;
          queueMicrotask(() => {
            if (file === "ssh")
              child.stdout.emit(
                "data",
                Buffer.from(
                  `discarded ${token}\nARMADA_ORCHESTRATOR_RECEIPT ${Buffer.from(JSON.stringify({ physicalGeneration: boot, acknowledged: true, port: 32100, epoch: "2", authorityInstalled: true })).toString("base64url")}\n`,
                ),
              );
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
  const provider = {
    sshKey: async () => ({ sshEndpoint: "ssh.test:2222", hostKey: "ssh-ed25519 PINNED" }),
  } as unknown as Provider;
  const response = await sshOrchestratorReceipt(
    provider,
    { sandboxId: "fixture", token, script: "public-code-only" },
    deps,
  );
  expect(response.physicalGeneration).toBe(boot);
  expect(response.authorityInstalled).toBe(true);
  expect(calls.find((c) => c.file === "ssh")?.args).toContain("StrictHostKeyChecking=yes");
  expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(token);
  expect(writes.join("")).not.toContain(token);
  expect(calls.find((c) => c.file === "ssh")?.stdin).toContain(token + "\n");
});

test("private SSH removes only its temporary guest authorization before success or failed control", async () => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn: realSpawn } = await import("node:child_process");
  const home = await mkdtemp(join(tmpdir(), "armada-private-key-"));
  const authorized = join(home, ".ssh/authorized_keys");
  const unrelated = "ssh-ed25519 UNRELATED user-key\n";
  await mkdir(join(home, ".ssh"));
  await writeFile(authorized, unrelated, { mode: 0o600 });
  const provider = {
    sshKey: async ({ key }: { key: string }) => {
      await writeFile(authorized, (await readFile(authorized, "utf8")) + key + "\n");
      return { sshEndpoint: "ssh.test:2222", hostKey: "ssh-ed25519 PINNED" };
    },
  } as unknown as Provider;
  const run = ((file: string, args: string[], options: Parameters<typeof realSpawn>[2]) =>
    file === "ssh"
      ? realSpawn("bash", ["-c", `bash -c ${args.at(-1)}`], { ...options, env: { ...process.env, HOME: home } })
      : realSpawn(file, args, options)) as typeof realSpawn;
  const receipt = Buffer.from(
    JSON.stringify({ physicalGeneration: "00000000-0000-4000-8000-000000000001", acknowledged: true }),
  ).toString("base64url");
  try {
    for (const script of [
      `printf 'ARMADA_ORCHESTRATOR_RECEIPT ${receipt}\\n'`,
      "exit 7",
      `printf 'ARMADA_ORCHESTRATOR_RECEIPT ${receipt}\\n'`,
    ]) {
      const result = sshOrchestratorReceipt(
        provider,
        { sandboxId: "fixture", token: "private-payload", script },
        { spawn: run },
      );
      if (script === "exit 7") await expect(result).rejects.toThrow("orchestrator_private_ssh_unavailable");
      else expect((await result).acknowledged).toBe(true);
      expect(await readFile(authorized, "utf8")).toBe(unrelated);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
