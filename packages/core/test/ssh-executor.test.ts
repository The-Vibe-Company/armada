import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { shellQuote, sshStdinCheckout } from "../src/server.ts";

const provider: any = { sshKey: async () => ({ sshEndpoint: "ssh.test:2222", hostKey: "ssh-ed25519 AAAAPINNED" }) };
describe("SSH stdin checkout", () =>
  test("pins host and keeps token out of argv/files", async () => {
    const calls: any[] = [];
    const writes: any[] = [];
    let removed = false;
    const spawn: any = (file: string, args: string[]) => {
      calls.push({ file, args });
      const c: any = new EventEmitter();
      c.stdin = {
        end: (v: string) => {
          calls[calls.length - 1].stdin = v;
          queueMicrotask(() => c.emit("close", 0));
        },
      };
      c.stderr = new EventEmitter();
      return c;
    };
    await sshStdinCheckout(provider, { sandboxId: "bx", token: "ghs_SECRET", script: "git clone x" }, {
      spawn,
      mkdtemp: async () => "/tmp/k",
      chmod: async () => {},
      writeFile: async (p: any, v: any) => {
        writes.push([p, v]);
      },
      rm: async () => {
        removed = true;
      },
      readPublicKey: async () => "ssh-ed25519 AAAA ephemeral",
    } as any);
    expect(JSON.stringify(calls.map((x) => x.args))).not.toContain("ghs_SECRET");
    expect(JSON.stringify(writes)).not.toContain("ghs_SECRET");
    expect(calls[1].args).toContain("StrictHostKeyChecking=yes");
    expect(calls[1].stdin).toContain("ghs_SECRET\n");
    expect(writes[0][1]).toContain("ssh-ed25519 AAAAPINNED");
    expect(removed).toBe(true);
  }));

test("the argv-joined remote shell reads the secret first line instead of executing it", async () => {
  const calls: { file: string; args: string[]; stdin?: string }[] = [];
  const fakeProvider = {
    sshKey: async () => ({ sshEndpoint: "ssh.test:2222", hostKey: "ssh-ed25519 AAAAPINNED" }),
  } as any;
  const spawn: any = (file: string, args: string[]) => {
    calls.push({ file, args });
    const child: any = new EventEmitter();
    child.stdin = {
      end: (stdin: string) => {
        calls[calls.length - 1]!.stdin = stdin;
        queueMicrotask(() => child.emit("close", 0));
      },
    };
    child.stderr = new EventEmitter();
    return child;
  };
  await sshStdinCheckout(
    fakeProvider,
    {
      sandboxId: "bx",
      token: "$(echo SHOULD_NOT_RUN)",
      script: "test \"$ARMADA_GIT_TOKEN\" = '$(echo SHOULD_NOT_RUN)'",
    },
    {
      spawn,
      mkdtemp: async () => "/tmp/k",
      chmod: async () => {},
      writeFile: async () => {},
      rm: async () => {},
      readPublicKey: async () => "ssh-ed25519 PUBLIC",
    } as any,
  );
  const ssh = calls[1]!;
  const remote = ssh.args.at(-1)!;
  const joined = `bash -c ${remote}`;
  const result = spawnSync("bash", ["-c", joined], { input: ssh.stdin, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
  expect(result.stderr).not.toContain("+ ");
});

test("shellQuote round-trips a value containing single quotes through a real shell", () => {
  const value = "it's a trap' ; rm -rf / #";
  const result = spawnSync("bash", ["-c", `printf '%s' ${shellQuote(value)}`], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(value);
});
