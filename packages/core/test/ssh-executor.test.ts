import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote, sshStdinCheckout } from "../src/server.ts";

const provider: any = { sshKey: async () => ({ sshEndpoint: "ssh.test:2222", hostKey: "ssh-ed25519 AAAAPINNED" }) };
describe("SSH stdin checkout", () =>
  test.each([undefined, "user", "root", "admin"])(
    "pins host and validates provider SSH identity %s without argv/file secrets",
    async (username) => {
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
      const selected = {
        ...provider,
        sshKey: async () => ({ ...(await provider.sshKey()), ...(username ? { username } : {}) }),
      };
      const checkout = sshStdinCheckout(selected, { sandboxId: "bx", token: "ghs_SECRET", script: "git clone x" }, {
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
      if (username === "admin") {
        await expect(checkout).rejects.toMatchObject({ code: "setup_failed" });
        expect(calls.map((call) => call.file)).toEqual(["ssh-keygen"]);
        expect(removed).toBe(true);
        return;
      }
      await checkout;
      expect(calls[1].args).toContain((username ?? "user") + "@ssh.test");
      expect(JSON.stringify(calls.map((x) => x.args))).not.toContain("ghs_SECRET");
      expect(JSON.stringify(writes)).not.toContain("ghs_SECRET");
      expect(calls[1].args).toContain("StrictHostKeyChecking=yes");
      expect(calls[1].stdin).toContain("ghs_SECRET\n");
      expect(writes[0][1]).toContain("ssh-ed25519 AAAAPINNED");
      expect(removed).toBe(true);
    },
  ));

test.each([undefined, "user", "root"] as const)(
  "the argv-joined remote shell preserves stdin and trusted %s home",
  async (username) => {
    const calls: { file: string; args: string[]; stdin?: string }[] = [];
    const fakeProvider = {
      sshKey: async () => ({ sshEndpoint: "ssh.test:2222", hostKey: "ssh-ed25519 AAAAPINNED", username }),
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
    const destination = ssh.args.indexOf(`${username ?? "user"}@ssh.test`);
    expect(destination).toBeGreaterThanOrEqual(0);
    const joined = ssh.args.slice(destination + 1).join(" ");
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "armada-ssh-remote-home-")));
    try {
      const inheritedHome = join(fixture, "inherited-home");
      const remoteHome = join(fixture, "remote-home");
      const bashEnv = join(fixture, "bash-env");
      mkdirSync(inheritedHome);
      mkdirSync(remoteHome);
      // Model only the VM's fixed directory in an owned fixture. The actual joined SSH
      // command, bash -c prefix, stdin protocol and root HOME assignment run unchanged.
      writeFileSync(
        bashEnv,
        'cd() { if [ "$#" -eq 1 ] && [ "$1" = /home/user ]; then builtin cd -- "$ARMADA_TEST_REMOTE_HOME"; else builtin cd "$@"; fi; }\n',
        { mode: 0o600 },
      );
      const result = spawnSync("bash", ["-c", joined], {
        input: `${ssh.stdin}\nprintf '%s\\n' "$HOME" "$PWD"\n`,
        encoding: "utf8",
        cwd: inheritedHome,
        env: {
          ...process.env,
          HOME: inheritedHome,
          GIT_CONFIG_GLOBAL: "/dev/null",
          BASH_ENV: bashEnv,
          ARMADA_TEST_REMOTE_HOME: remoteHome,
        },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        username === "root" ? `/home/user\n${remoteHome}\n` : `${inheritedHome}\n${inheritedHome}\n`,
      );
      expect(JSON.stringify(ssh.args)).not.toContain("SHOULD_NOT_RUN");
      expect(result.stderr).not.toContain("+ ");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);

test("shellQuote round-trips a value containing single quotes through a real shell", () => {
  const value = "it's a trap' ; rm -rf / #";
  const result = spawnSync("bash", ["-c", `printf '%s' ${shellQuote(value)}`], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(value);
});

test("real SSH remote shell reports only allowlisted phase and exit code, never tool stderr", async () => {
  const { spawn } = await import("node:child_process");
  const { goldenScript, withGoldenDirs } = await import("../src/server.ts");
  // Exercise the production stdin protocol and real bash, without network or installing a golden.
  const remoteSpawn: typeof spawn = ((file: string, args: string[], options: any) => {
    if (file !== "ssh") return spawn(file, args, options);
    const destination = args.indexOf("user@ssh.test");
    return spawn("bash", ["-c", args.slice(destination + 1).join(" ")], options);
  }) as typeof spawn;
  const prepared = withGoldenDirs([{ owner: "acme", repo: "web", id: 1, installationId: 2 }]);
  const script = goldenScript(prepared);
  // Fail before clone: unstructured stderr must not escape even for non-GitHub-shaped secrets.
  const failing = script.replace(
    "export GIT_CONFIG_NOSYSTEM=1",
    "printf 'opaque-private-value\\n' >&2; false\nexport GIT_CONFIG_NOSYSTEM=1",
  );
  let failure: unknown;
  try {
    await sshStdinCheckout(
      provider,
      { sandboxId: "bx", token: "opaque-private-value", script: failing },
      { spawn: remoteSpawn },
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "build_failed" });
  expect(String(failure)).toContain("checkout (exit_1)");
  expect(String(failure)).not.toContain("opaque-private-value");
});

test.each(["admin", "root; touch /tmp/forged", "", null])(
  "refuses invalid SSH username metadata %s before SSH",
  async (username) => {
    const { spawn } = await import("node:child_process");
    let sshStarted = false;
    const guardedSpawn: typeof spawn = ((file: string, args: string[], options: any) => {
      if (file === "ssh") {
        sshStarted = true;
        throw Error("SSH must not start");
      }
      return spawn(file, args, options);
    }) as typeof spawn;
    await expect(
      sshStdinCheckout(
        { sshKey: async () => ({ sshEndpoint: "ssh.test:2222", hostKey: "ssh-ed25519 AAAAPINNED", username }) } as any,
        { sandboxId: "bx", token: "stdin-only", script: "true" },
        { spawn: guardedSpawn },
      ),
    ).rejects.toThrow("Invalid SSH username.");
    expect(sshStarted).toBe(false);
  },
);
