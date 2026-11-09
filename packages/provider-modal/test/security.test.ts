import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { Sandbox } from "modal";
import { createGenerationGrants, createSshPreparation, type Machine, type Scope, scrubSsh } from "../src/index.ts";

const scope: Scope = {
  orgId: "org",
  userId: "owner",
  visibility: "private",
  binding: { workspace: "workspace", environment: "main", appId: "ap_bound" },
};
const machine: Machine = {
  info: { id: "logical", name: "test", state: "ready", providerState: "active", labels: {} },
  phase: "active",
  generation: 4,
  grantExpiresAt: Date.now() + 60_000,
  golden: true,
  ttlSeconds: 60,
  physicalName: "physical",
};
test("generation grants authenticate immutable tenant/App scope and expiry without storing tokens", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const service = createGenerationGrants(key, scope);
  const grant = service.issue(machine);
  expect((await service.verifyGrant(grant.token)).claims).toMatchObject({ sandboxId: "logical", generation: "4" });
  const other = createGenerationGrants(key, { ...scope, binding: { ...scope.binding, appId: "ap_other" } });
  await expect(other.verifyGrant(grant.token)).rejects.toMatchObject({ code: "unauthorized" });
  await expect(service.verifyGrant(`${grant.token}corrupt`)).rejects.toMatchObject({ code: "unauthorized" });
  expect(() => service.issue({ ...machine, grantExpiresAt: Date.now() - 1 })).toThrow();
});
test("SSH registration accepts only an Ed25519 public key and sends it on stdin, returning actual pinned tunnel hostkey", async () => {
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const encoded = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    publicKey,
  ]).toString("base64");
  const key = `ssh-ed25519 ${encoded}`;
  let stdin = "";
  let calls = 0;
  const sandbox = {
    async exec(argv: string[]) {
      calls++;
      expect(argv.join(" ")).not.toContain(encoded);
      return {
        stdin: {
          writeText: async (value: string) => {
            stdin += value;
          },
          close: async () => {},
        },
        stdout: { readText: async () => `${key} generated-host\n` },
        wait: async () => 0,
      };
    },
    tunnels: async () => ({ 2222: { tcpSocket: ["ssh.example", 1234] } }),
  } as unknown as Sandbox;
  const ssh = createSshPreparation();
  await expect(ssh.prepare(sandbox, machine, `${key}\ncommand=evil`)).rejects.toMatchObject({
    code: "invalid_request",
  });
  expect(calls).toBe(0);
  expect(await ssh.prepare(sandbox, machine, key)).toEqual({
    endpoint: "ssh.example:1234",
    hostPublicKey: `${key} generated-host`,
    username: "root",
  });
  expect(stdin).toBe(`${key}\n`);
});

test("snapshot quiescence shell is valid and a failed remote scrub prevents success", async () => {
  let calls = 0;
  const sandbox = {
    async exec(argv: string[]) {
      calls++;
      if (calls === 1) return { stdin: { writeText: async () => {}, close: async () => {} }, wait: async () => 0 };
      const parser = Bun.spawn(["bash", "-n"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      parser.stdin.write(argv[2] ?? "");
      parser.stdin.end();
      expect(await parser.exited).toBe(0);
      return { stdin: { writeText: async () => {}, close: async () => {} }, wait: async () => 1 };
    },
  } as unknown as Sandbox;
  await expect(
    scrubSsh(sandbox, {
      ...machine,
      physicalId: "fixture",
      processBaseline: {
        version: 1,
        physicalId: "fixture",
        generation: machine.generation,
        namespace: { pid: "fixture", mount: "fixture" },
        processes: [{ pid: 1, start: "1" }],
      },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
});
