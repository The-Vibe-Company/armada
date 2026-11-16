import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createSshPreparation } from "../../provider-modal/src/ssh.ts";
import { installPrivateSkill } from "../src/private-skill.ts";
import { goldenScript, type Provider, scanGoldenSandbox, sshStdinCheckout, withGoldenDirs } from "../src/server.ts";

/** Opt-in real OS/SSH conformance, not a fake tool-version probe.
 * Build scripts/fixtures/golden-os first. The recipe performs actual npm/Playwright/apt installs.
 * Only the fixture Git remote location is redirected to a real local Git repository.
 */
test.skipIf(!process.env.ARMADA_GOLDEN_OS_IMAGE).each(["user-standard", "root-nnp"] as const)(
  "golden SSH recipe %s preserves worker ownership/private runner Bun and root scanner access",
  async (mode) => {
    const image = process.env.ARMADA_GOLDEN_OS_IMAGE!;
    const rootSsh = mode === "root-nnp";
    const username = rootSsh ? "root" : "user";
    const name = `armada-golden-os-${crypto.randomUUID()}`;
    const docker = (args: string[], stdin?: string, user?: string) =>
      spawnSync("docker", [...(user ? ["exec", "-i", "--user", user, name] : []), ...args], {
        input: stdin,
        encoding: "utf8",
        timeout: 900_000,
        maxBuffer: 1024 * 1024,
      });
    try {
      const created = docker([
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        ...(rootSsh ? ["--security-opt", "no-new-privileges:true"] : []),
        "-p",
        "127.0.0.1::22",
        "-p",
        "127.0.0.1::2222",
        image,
        "/bin/sh",
        "-c",
        "ssh-keygen -A && /usr/bin/git daemon --detach --user=user --group=user --listen=127.0.0.1 --base-path=/opt --export-all && exec /usr/sbin/sshd -D -e -o PermitRootLogin=prohibit-password -o PasswordAuthentication=no",
      ]);
      if (created.status !== 0) throw new Error("Could not start golden OS fixture.");
      const ready = docker(
        ["bash", "-c", "until ssh-keyscan -T 1 localhost >/dev/null 2>&1; do :; done"],
        undefined,
        "0",
      );
      expect(ready.status).toBe(0);
      const endpoint = docker(["port", name, "22/tcp"]).stdout.trim();
      const hostKey = docker(["cat", "/etc/ssh/ssh_host_ed25519_key.pub"], undefined, "0").stdout.trim();
      const provider = {
        sshKey: async ({ key }: { key: string }) => {
          const authorized = docker(
            [
              "bash",
              "-c",
              rootSsh
                ? "install -d -m 700 /root/.ssh; cat >> /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys"
                : "install -d -m 700 -o user -g user /home/user/.ssh; cat >> /home/user/.ssh/authorized_keys; chown user:user /home/user/.ssh/authorized_keys; chmod 600 /home/user/.ssh/authorized_keys",
            ],
            `${key}\n`,
            "0",
          );
          if (authorized.status !== 0) throw new Error("Could not authorize fixture SSH key.");
          return { sshEndpoint: endpoint, hostKey, username };
        },
        exec: async ({ command }: { command: string }) => {
          const result = docker(["bash", "-c", command], undefined, username);
          return {
            detached: false,
            exitCode: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut: Boolean(result.error),
            truncated: false,
          };
        },
      } as unknown as Provider;
      const repos = withGoldenDirs([{ owner: "fixture", repo: "app", branch: "main", id: 1, installationId: 1 }]);
      await sshStdinCheckout(provider, {
        sandboxId: name,
        token: "synthetic-stdin-only-checkout",
        script: goldenScript(repos, [
          rootSsh ? 'test "$(id -u)" -eq 0' : 'test "$(id -u)" -ne 0',
          'test "$HOME" = /home/user',
          ...(rootSsh
            ? ["grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status", "! runuser -u user -- sudo -n true 2>/dev/null"]
            : []),
          "mkdir -p /home/user/.local",
          "ln -s /opt/armada/runtime-bun /home/user/.local/runner-link",
          'test "$(/usr/local/bin/bun --version)" = 1.3.14',
          'test "$(/opt/armada/runtime-bun/bun --version)" = 1.4.2',
          'test "$(skillpack --version)" = "skillpack 0.3.5"',
          "skillpack auth status --help >/dev/null",
        ]),
      });
      const versions = docker(
        [
          "bash",
          "-c",
          'test "$(id -u)" -ne 0 && test "$(skillpack --version)" = "skillpack 0.3.5" && test "$(bun --version)" = 1.3.14 && test "$(/opt/armada/runtime-bun/bun --version)" = 1.4.2',
        ],
        undefined,
        "user",
      );
      expect(versions.status).toBe(0);
      const sudoVersion = docker(["dpkg-query", "-W", "-f=" + "$" + "{Version}", "sudo"], undefined, "user");
      expect(sudoVersion.stdout.trim()).toBe("1.9.13p3-1+deb12u4");
      await scanGoldenSandbox(provider, name);
      // The actual production sudo scanner must see root-owned files, without printing contents.
      const fixtureSecret = `ghp_${"X".repeat(40)}`;
      expect(docker(["bash", "-c", "cat > /root/armada-scanner-fixture"], fixtureSecret, "0").status).toBe(0);
      await expect(scanGoldenSandbox(provider, name)).rejects.toMatchObject({ code: "setup_failed" });
      expect(docker(["rm", "/root/armada-scanner-fixture"], undefined, "0").status).toBe(0);
      await scanGoldenSandbox(provider, name);
      const ownership = docker(
        [
          "bash",
          "-c",
          'test "$(stat -c %U /home/user/app/.git/config)" = user && test "$(stat -c %U /home/user/.bun-npm/bin/bun)" = user && test "$(stat -c %U /opt/armada/runtime-bun/bun)" = root && test -w /home/user/app/package.json && test -w /home/user/.cache',
        ],
        undefined,
        "user",
      );
      expect(ownership.status).toBe(0);
      if (!rootSsh) {
        // Actual Modal worker registration/tunnel/host pin and SSH under NNP;
        // only the registry CLI is replaced, avoiding network/auth credentials.
        const port = Number(docker(["port", name, "2222/tcp"]).stdout.trim().split(":").at(-1));
        const preparation = createSshPreparation();
        const sdk = {
          exec: async (argv: string[]) => {
            const proc = Bun.spawn(["docker", "exec", "-i", name, "setpriv", "--no-new-privs", ...argv], {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "ignore",
            });
            return {
              stdin: {
                writeText: async (text: string) => {
                  proc.stdin.write(text);
                },
                close: async () => {
                  proc.stdin.end();
                },
              },
              stdout: { readText: () => new Response(proc.stdout).text() },
              wait: () => proc.exited,
            };
          },
          tunnels: async () => ({ 2222: { tcpSocket: ["127.0.0.1", port] } }),
        };
        const modalProvider = {
          sshKey: async ({ key }: { key: string }) => {
            const c = await preparation.prepare(
              sdk as unknown as Parameters<typeof preparation.prepare>[0],
              { golden: false } as Parameters<typeof preparation.prepare>[1],
              key,
            );
            return { sshEndpoint: c.endpoint, hostKey: c.hostPublicKey, username: c.username };
          },
        } as unknown as Provider;
        const fake =
          '#!/usr/bin/env node\nif(process.argv[2]!=="auth")process.exit(3);console.log(JSON.stringify({workspace:{id:"11111111-1111-4111-8111-111111111111"},token:{scopes:["skills:read","secrets:read"]}}));\n';
        expect(
          docker(
            [
              "bash",
              "-c",
              "cat >/tmp/skillpack-fixture; chmod 755 /tmp/skillpack-fixture; mv /usr/local/bin/skillpack /tmp/native-skillpack-link; ln -s /tmp/skillpack-fixture /usr/local/bin/skillpack",
            ],
            fake,
            "0",
          ).status,
        ).toBe(0);
        const install = () =>
          installPrivateSkill(modalProvider, {
            sandboxId: name,
            projectDir: "/home/user/app",
            reference: "notes@1.0.0",
            harness: "codex",
            key: "cmp_pat_" + "a".repeat(48),
          });
        await expect(install()).rejects.toMatchObject({ reason: "skillpack_credential_refused", stage: "install" });
        expect(
          docker(
            [
              "bash",
              "-c",
              "touch /home/user/.ssh/authorized_keys.armada.lock; chown root:root /home/user/.ssh/authorized_keys.armada.lock; chmod 600 /home/user/.ssh/authorized_keys.armada.lock",
            ],
            undefined,
            "0",
          ).status,
        ).toBe(0);
        await expect(install()).rejects.toMatchObject({
          reason: "skillpack_ssh_key_cleanup_failed",
          stage: "transport",
        });
      }
    } finally {
      docker(["rm", "-f", name]);
    }
  },
  900_000,
);
