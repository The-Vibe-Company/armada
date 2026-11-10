import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
          'test "$(id -u)" -ne 0 && test "$(bun --version)" = 1.3.14 && test "$(/opt/armada/runtime-bun/bun --version)" = 1.4.2',
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
    } finally {
      docker(["rm", "-f", name]);
    }
  },
  900_000,
);
