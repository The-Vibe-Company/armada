import { expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import { type Provider, type SshExecDeps, sshDelegatedReceipt } from "../src/server.ts";

test.each([
  { outcome: "successful", exitCode: 0 },
  { outcome: "failed", exitCode: 7 },
])("private SSH removes only its temporary authorization before $outcome guest control", async ({ exitCode }) => {
  const token = `armada_epoch_${"a".repeat(64)}`;
  const boot = "00000000-0000-4000-8000-000000000001";
  const publicKey = "ssh-ed25519 TEMPORARY";
  const unrelated = "ssh-ed25519 UNRELATED user-key\nssh-ed25519 TEMPORARY different-comment\n";
  const calls: { file: string; args: string[]; stdin?: string }[] = [];
  const writes: string[] = [];
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
            if (file === "ssh") {
              const receipt = {
                physicalGeneration: boot,
                acknowledged: true,
                port: 32100,
                epoch: "2",
                authorityInstalled: true,
              };
              child.stdout.emit(
                "data",
                Buffer.from(
                  `discarded ${token}\nARMADA_ORCHESTRATOR_RECEIPT ${Buffer.from(JSON.stringify(receipt)).toString("base64url")}\n`,
                ),
              );
            }
            child.emit("close", file === "ssh" ? exitCode : 0);
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
    readPublicKey: async () => publicKey,
  };
  const home = fs.mkdtempSync(path.join(tmpdir(), "armada-private-key-"));
  const authorized = path.join(home, ".ssh", "authorized_keys");
  const provider = {
    sshKey: async ({ key }: { key: string }) => {
      fs.writeFileSync(authorized, unrelated + key + "\n", { mode: 0o600 });
      return { sshEndpoint: "ssh.test:2222", hostKey: "ssh-ed25519 PINNED" };
    },
  } as unknown as Provider;
  const control = "public-code-only";
  try {
    fs.mkdirSync(path.dirname(authorized));
    const result = sshDelegatedReceipt(provider, { sandboxId: "fixture", token, script: control }, deps);
    if (exitCode === 0) {
      const response = await result;
      expect(response.physicalGeneration).toBe(boot);
      expect(response.acknowledged).toBe(true);
      expect(response.authorityInstalled).toBe(true);
    } else {
      await expect(result).rejects.toThrow("orchestrator_private_ssh_unavailable");
    }

    const ssh = calls.find((call) => call.file === "ssh");
    expect(ssh?.args).toContain("StrictHostKeyChecking=yes");
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(token);
    expect(writes.join("")).not.toContain(token);

    const [stdinToken, stdinKey, ...script] = ssh?.stdin?.split("\n") ?? [];
    expect(stdinToken).toBe(token);
    expect(stdinKey).toBe(publicKey);
    const beforeControl = script.join("\n").split(control)[0];
    expect(script.join("\n")).toEndWith(control);
    const cleanup = beforeControl?.match(
      /node <<'ARMADA_PRIVATE_KEY_CLEANUP'\n([\s\S]*?)\nARMADA_PRIVATE_KEY_CLEANUP\n/,
    );
    expect(cleanup).toBeDefined();
    expect(fs.readFileSync(authorized, "utf8")).toBe(unrelated + publicKey + "\n");
    runInNewContext(cleanup?.[1] ?? "", {
      require: (name: "node:fs" | "node:path") => ({ "node:fs": fs, "node:path": path })[name],
      process: {
        env: { ARMADA_KEY_HOME: home, ARMADA_SSH_PUBLIC_KEY: stdinKey },
        pid: process.pid,
        getuid: () => process.getuid?.() ?? 1,
        exit: (code: number) => {
          throw Error(`Guest cleanup exited with ${code}`);
        },
      },
    });
    expect(fs.readFileSync(authorized, "utf8")).toBe(unrelated);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
