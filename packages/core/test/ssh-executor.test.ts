import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { sshStdinCheckout } from "../src/index.ts";

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
