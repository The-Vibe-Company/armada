import { expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { type Provider, type SshExecDeps, sshDelegatedReceipt } from "../src/server.ts";

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
  const response = await sshDelegatedReceipt(
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
