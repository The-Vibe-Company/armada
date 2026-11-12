import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { shellQuote, sshNativeAuthAdmission, sshPrivateAuthState, sshStdinCheckout } from "../src/server.ts";

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

test.each(["boat", "modal"] as const)(
  "private %s auth SSH captures only bounded fixed-path stdout, never argv/files/stderr",
  async (id) => {
    const secret =
      '{"tokens":{"access_token":"synthetic-private-access","refresh_token":"synthetic-private-refresh","account_id":"native"}}';
    const calls: { args: string[]; stdin?: string; stdio: unknown }[] = [];
    const writes: unknown[] = [];
    let removed = false,
      overflow = false;
    const fakeSpawn: any = (file: string, args: string[], options: { stdio: unknown }) => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      const record = { args, stdin: "", stdio: options.stdio };
      calls.push(record);
      child.stdin = {
        on: () => {},
        end: (input: string) => {
          record.stdin = input;
          queueMicrotask(() => {
            if (file === "ssh") {
              child.stderr.emit("data", Buffer.from("untrusted-private-stderr"));
              child.stdout.emit("data", Buffer.from(overflow ? "x".repeat(65537) : secret));
            }
            child.emit("close", 0);
          });
        },
      };
      return child;
    };
    const deps = {
      spawn: fakeSpawn,
      mkdtemp: (async () => "/private-fixture") as any,
      rm: async () => {
        removed = true;
      },
      chmod: async () => {},
      writeFile: (async (...args: unknown[]) => {
        writes.push(args);
      }) as any,
      readPublicKey: async () => "ssh-ed25519 PUBLIC",
    };
    const selected = { ...provider, id };
    expect(await sshPrivateAuthState(selected, "native", deps)).toBe(secret);
    // The generated remote program is a wire artifact: validate its executable
    // JavaScript, not only the mocked SSH process's receipt of stdin.
    const program = calls[1]?.stdin?.split("node <<'ARMADA_PRIVATE_AUTH'\n")[1]?.split("\nARMADA_PRIVATE_AUTH")[0];
    expect(program).toBeDefined();
    expect(() => new Script(program!)).not.toThrow();
    expect(calls[1]?.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(calls[1]?.stdin).toContain(
      id === "boat" ? "/home/user/.codex/auth.json" : "/home/user/.armada-runtime/codex/auth.json",
    );
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain("synthetic-private");
    expect(JSON.stringify(writes)).not.toContain("synthetic-private");
    expect(removed).toBe(true);
    if (id === "boat") {
      // Exercise the actual private wire program: missing native auth is safe
      // only with a private, exact sandbox broker capability receipt.
      for (const proof of ["matching", "wrong", "missing", "unsafe", "managed"] as const) {
        const config = "/home/user/.armada/model-access.json";
        const files = new Map<string, string>();
        if (proof !== "missing")
          files.set(
            config,
            JSON.stringify({ capability: proof === "wrong" ? "other-capability" : "synthetic-capability" }),
          );
        const metadata = (file: string) => ({
          uid: 1000,
          nlink: 1,
          size: Buffer.byteLength(files.get(file) ?? ""),
          mode: proof === "unsafe" && file === config ? 0o644 : 0o600,
          isSymbolicLink: () => false,
          isDirectory: () => !files.has(file),
          isFile: () => files.has(file),
        });
        if (proof === "managed") files.set("/home/user/.codex/.armada-managed-native", "paused");
        const output: string[] = [];
        const guest = {
          env: { ARMADA_GIT_TOKEN: "synthetic-capability" },
          stdout: { write: (text: string) => output.push(text) },
          exitCode: 0,
        };
        new Script(program!).runInNewContext({
          Buffer,
          process: guest,
          require: () => ({
            constants: { O_RDONLY: 0, O_NOFOLLOW: 1 },
            lstatSync: (file: string) => {
              if (file.endsWith("/.armada-managed-native") && !files.has(file))
                throw Object.assign(new Error("absent"), { code: "ENOENT" });
              return metadata(file);
            },
            fstatSync: metadata,
            openSync: (file: string) => {
              if (!files.has(file)) throw Object.assign(new Error("absent"), { code: "ENOENT" });
              return file;
            },
            readSync: (file: string, bytes: Buffer) => Buffer.from(files.get(file) ?? "").copy(bytes),
            closeSync: () => {},
          }),
        });
        expect(output.join("")).toBe(proof === "matching" ? "null" : proof === "managed" ? "pending" : "");
        expect(guest.exitCode).toBe(proof === "matching" || proof === "managed" ? 0 : 1);
      }
      await sshPrivateAuthState(selected, "native", deps, false, "synthetic-capability");
      expect(calls.at(-1)?.stdin).toStartWith("synthetic-capability\n");
      expect(JSON.stringify(calls.map((call) => call.args))).not.toContain("synthetic-capability");
      expect(JSON.stringify(writes)).not.toContain("synthetic-capability");
      await sshNativeAuthAdmission(selected, "native", false, deps);
      const admission = calls
        .at(-1)
        ?.stdin?.split("node <<'ARMADA_NATIVE_ADMISSION'\n")[1]
        ?.split("\nARMADA_NATIVE_ADMISSION")[0];
      expect(admission).toBeDefined();
      expect(() => new Script(admission!)).not.toThrow();
    }
    overflow = true;
    await expect(sshPrivateAuthState(selected, "native", deps)).rejects.toThrow("Private native auth exchange failed.");
  },
);

// Fixed protocol records are the only guest metadata admitted to build results.
test.each(["warning", "integrity"])("SSH checkout carries closed build outcome %s", async (mode) => {
  const warnings: string[] = [];
  const spawn: any = (file: string) => {
    const c: any = new EventEmitter();
    c.stderr = new EventEmitter();
    c.stdin = {
      end: () =>
        queueMicrotask(() => {
          if (file === "ssh") {
            c.stderr.emit("data", "opaque guest detail\nARMADA_BUILD_WARN");
            c.stderr.emit(
              "data",
              mode === "warning"
                ? "ING skillpack download_unavailable\nARMADA_BUILD_WARNING skillpack secret-not-allowed\n"
                : "ING skillpack unknown\nARMADA_BUILD_FAILURE skillpack 98\n",
            );
          }
          c.emit("close", file === "ssh" && mode === "integrity" ? 98 : 0);
        }),
    };
    return c;
  };
  const run = sshStdinCheckout(
    provider,
    { sandboxId: "bx", token: "synthetic", script: "unused" },
    {
      spawn,
      onWarning: (warning) => warnings.push(warning),
      chmod: async () => {},
      writeFile: async () => {},
      readPublicKey: async () => "ssh-ed25519 AAAA ephemeral",
    },
  );
  if (mode === "integrity")
    await expect(run).rejects.toMatchObject({ code: "build_failed", safeReason: "skillpack_integrity_failed" });
  else {
    await run;
    expect(warnings).toEqual(["skillpack_download_unavailable"]);
  }
});
