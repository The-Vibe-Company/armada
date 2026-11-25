import { describe, expect, test } from "bun:test";
import { type ChildProcess, type spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Provider, shellQuote, sshStdinCheckout } from "../src/server.ts";

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

test.each(["checkout", "explicit-init-exit"])(
  "real SSH remote shell reports only allowlisted phase and exit code (%s)",
  async (mode) => {
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
      mode === "checkout"
        ? "printf 'opaque-private-value\\n' >&2; false\nexport GIT_CONFIG_NOSYSTEM=1"
        : "armada_phase=init; armada_command=2; printf 'opaque-private-value\\n' >&2; exit 17",
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
    if (mode === "checkout") expect(String(failure)).toContain("checkout (exit_1)");
    else expect(failure).toMatchObject({ safeMessage: "Init command 2 exited 17. Correct the command, then rebuild." });
    expect(String(failure)).not.toContain("opaque-private-value");
  },
);

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

// Fixed protocol records are the only guest metadata admitted to build results.
test.each(["warning", "integrity", "init", "clone", "helper"])("SSH checkout reports %s", async (mode) => {
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
                : mode === "init"
                  ? "ING skillpack unknown\nARMADA_BUILD_FAILURE init 17 2\n"
                  : mode === "clone"
                    ? "ING skillpack unknown\nARMADA_BUILD_FAILURE checkout 128 0\n"
                    : mode === "helper"
                      ? "ING skillpack unknown\nARMADA_BUILD_FAILURE helper 98\n"
                      : "ING skillpack unknown\nARMADA_BUILD_FAILURE skillpack 98\nARMADA_GITHUB_FAILURE directories\n",
            );
          }
          c.emit("close", file === "ssh" && mode !== "warning" ? 98 : 0);
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
  else if (mode === "helper")
    await expect(run).rejects.toMatchObject({
      safePhase: "helper",
      safeMessage: "Build failed during helper (exit_98). Check connectivity, permissions and package availability.",
    });
  else if (mode === "init" || mode === "clone")
    await expect(run).rejects.toMatchObject({
      safePhase: mode === "init" ? "init" : "checkout",
      safeMessage:
        mode === "init"
          ? "Init command 2 exited 17. Correct the command, then rebuild."
          : "Clone failed (exit 128). Check the requested branches and GitHub access, then rebuild.",
    });
  else {
    await run;
    expect(warnings).toEqual(["skillpack_download_unavailable"]);
  }
});

test.each([
  ["missing /opt/armada/runtime-bun/bun", "/opt/armada/runtime-bun/bun is missing or has the wrong file type"],
  ["mode /opt/armada/runtime-bun", "/opt/armada/runtime-bun has unsafe permissions"],
  ["owner /opt/armada", "/opt/armada is not root-owned"],
  ["owner /opt", "/opt is not root-owned"],
  ["symlink /opt/armada", "/opt/armada is a symlink"],
  ["ffi", "Bun could not load Linux glibc through FFI"],
  ["proc_fd", "the collector could not open a directory through /proc/self/fd"],
  ["owner /private-tool-stderr", "Verify the managed Bun executable"],
])("SSH reports the safe collector check for exit 86 (%s)", async (reason, expected) => {
  const spawn: any = (file: string) => {
    const child: any = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end: () =>
        queueMicrotask(() => {
          if (file === "ssh") {
            child.stderr.emit(
              "data",
              `ARMADA_OUTPUT_COLLECTOR_FAILURE ${reason}\nARMADA_BUILD_FAILURE output_collector 86 0\n`,
            );
          }
          child.emit("close", file === "ssh" ? 86 : 0);
        }),
    };
    return child;
  };
  await expect(
    sshStdinCheckout(
      provider,
      { sandboxId: "bx", token: "fixture", script: "unused" },
      {
        spawn,
        chmod: async () => {},
        writeFile: async () => {},
        readPublicKey: async () => "ssh-ed25519 AAAA ephemeral",
      },
    ),
  ).rejects.toMatchObject({
    code: "build_failed",
    safePhase: "output_collector",
    safeMessage: expect.stringContaining(
      `The sandbox output collector exited 86. ${reason === "owner /private-tool-stderr" ? "" : "Failed check: "}${expected}`,
    ),
  });
});

test.each([
  ["ARMADA_GIT_FAILURE 2 auth_denied", "Could not clone acme/private: GitHub credentials were rejected."],
  ["ARMADA_GIT_FAILURE 2 repository_not_found", "GitHub could not find or authorize the repository."],
  ["ARMADA_GIT_FAILURE 2 branch_missing", "Ref 'feature/missing' was not found in acme/private."],
  ["ARMADA_GIT_FAILURE 2 transport_failed", "The Git transfer failed."],
  ["ARMADA_GIT_FAILURE 2 lfs_failed", "Git LFS checkout failed."],
  ["ARMADA_GIT_FAILURE 2 destination_exists", "The checkout destination already exists."],
  ["ARMADA_GIT_FAILURE 2 storage_failed", "The builder could not write the checkout."],
  ["ARMADA_GIT_FAILURE 2 unknown", "without a recognized safe reason"],
  ["ARMADA_GIT_FAILURE 17 auth_denied", "Clone failed (exit 128)."],
  ["ARMADA_GIT_FAILURE 0 auth_denied", "Clone failed (exit 128)."],
  ["ARMADA_GIT_FAILURE 2 opaque-secret", "Clone failed (exit 128)."],
  ["ARMADA_GIT_FAILURE acme/opaque-secret auth_denied", "Clone failed (exit 128)."],
])("SSH checkout publishes only a closed safe Git reason (%s)", async (record, expected) => {
  const spawn: any = (file: string) => {
    const child: any = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end: () =>
        queueMicrotask(() => {
          if (file === "ssh") {
            child.stderr.emit("data", "opaque-secret raw Git stderr\n" + record.slice(0, 12));
            child.stderr.emit("data", record.slice(12) + "\nARMADA_BUILD_FAILURE checkout 128 0\n");
          }
          child.emit("close", file === "ssh" ? 128 : 0);
        }),
    };
    return child;
  };
  let failure: any;
  try {
    await sshStdinCheckout(
      provider,
      {
        sandboxId: "bx",
        token: "opaque-secret",
        script: "unused",
        repositories: ["acme/public", "acme/private"],
        refs: ["main", "feature/missing"],
      },
      {
        spawn,
        chmod: async () => {},
        writeFile: async () => {},
        readPublicKey: async () => "ssh-ed25519 AAAA ephemeral",
      },
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "build_failed", safePhase: "checkout" });
  expect(failure.safeMessage).toContain(expected);
  expect(failure.safeMessage).toMatch(/(?:Git exited 128|Clone failed \(exit 128\))\./);
  expect(JSON.stringify(failure)).not.toContain("opaque-secret");
});

function cancellationTransport() {
  return {
    mkdtemp: async () => "/tmp/armada-fixture",
    chmod: async () => {},
    writeFile: async () => {},
    rm: async () => {},
    readPublicKey: async () => "ssh-ed25519 PUBLIC",
    spawn: (() => {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, {
        stdin: {
          end: () => queueMicrotask(() => child.emit("close", 0)),
        },
      });
      return child;
    }) as typeof spawn,
  } satisfies NonNullable<Parameters<typeof sshStdinCheckout>[2]>;
}
const diagnosticProvider = {
  id: "boat",
  sshKey: async () => ({ sshEndpoint: "ssh.test:2222", hostKey: "ssh-ed25519 AAAAPINNED" }),
} as unknown as Provider;

test("lease cancellation after SSH key registration prevents guest dispatch", async () => {
  const lease = new AbortController();
  const deps = cancellationTransport();
  const guestSshSpawns: string[] = [];
  const spawnImpl = deps.spawn;
  const provider = {
    ...diagnosticProvider,
    async sshKey() {
      const connection = await diagnosticProvider.sshKey({ sandboxId: "bx-test", key: "public" });
      queueMicrotask(() => lease.abort());
      return connection;
    },
  };
  const input = { sandboxId: "bx-test", token: "private", script: "true", signal: lease.signal };
  const result = sshStdinCheckout(provider, input, {
    ...deps,
    spawn: ((file: string, args: string[], options: object) => {
      if (file === "ssh") guestSshSpawns.push(file);
      return spawnImpl(file, args, options);
    }) as typeof spawn,
  });
  await result.catch(() => {});
  expect(guestSshSpawns).toHaveLength(0);
  await expect(result).rejects.toBe(lease.signal.reason);
});

test("lease cancellation kills the active guest SSH process", async () => {
  const lease = new AbortController();
  const deps = cancellationTransport();
  const spawnImpl = deps.spawn;
  const signals: string[] = [];
  const input = { sandboxId: "bx-test", token: "private", script: "true", signal: lease.signal };
  const result = sshStdinCheckout(diagnosticProvider, input, {
    ...deps,
    spawn: ((file: string, args: string[], options: object) => {
      if (file !== "ssh") return spawnImpl(file, args, options);
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, {
        kill: (signal: string) => signals.push(signal),
        stdin: {
          end: () =>
            queueMicrotask(() => {
              lease.abort();
              child.emit("close", signals.length ? null : 0);
            }),
        },
      });
      return child;
    }) as typeof spawn,
  });
  await expect(result).rejects.toBeInstanceOf(DOMException);
  expect(signals).toEqual(["SIGKILL"]);
});
