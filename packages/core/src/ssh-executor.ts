import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoldenError } from "./golden-config.ts";
import type { Provider } from "./provider.ts";
export interface SshExecDeps {
  mkdtemp?: typeof mkdtemp;
  rm?: typeof rm;
  writeFile?: typeof writeFile;
  chmod?: typeof chmod;
  readPublicKey?: (path: string) => Promise<string>;
  spawn?: typeof spawn;
}
/** Token is first stdin line. The one quoted remote command reads it before running the script. */
export async function sshStdinCheckout(
  provider: Provider,
  input: { sandboxId: string; token: string; script: string },
  deps: SshExecDeps = {},
): Promise<void> {
  const fs = {
    mkdtemp: deps.mkdtemp ?? mkdtemp,
    rm: deps.rm ?? rm,
    writeFile: deps.writeFile ?? writeFile,
    chmod: deps.chmod ?? chmod,
  };
  const run = deps.spawn ?? spawn;
  const dir = await fs.mkdtemp(join(tmpdir(), "armada-ssh-"));
  const key = join(dir, "key"),
    known = join(dir, "known_hosts");
  try {
    await command(run, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], "");
    await fs.chmod(key, 0o600);
    const pub = await (deps.readPublicKey ?? ((p: string) => Bun.file(p).text()))(`${key}.pub`);
    const c = await provider.sshKey({ sandboxId: input.sandboxId, key: pub.trim() });
    const username = c.username === undefined ? "user" : c.username;
    if (username !== "user" && username !== "root") throw new GoldenError("setup_failed", "Invalid SSH username.");
    const ep = parseEndpoint(c.sshEndpoint);
    await fs.writeFile(known, knownLine(ep.host, ep.port, c.hostKey), { mode: 0o600 });
    // ssh joins its command argv with spaces before the remote shell parses it. Keep this one
    // shell-quoted argument so semicolons cannot escape bash -c and turn `set +x` into a command.
    // The checkout script itself carries the cleanup trap; do not exec, which would discard it.
    const remote = shellQuote(
      "set +x; IFS= read -r ARMADA_GIT_TOKEN; IFS= read -r ARMADA_SSH_PUBLIC_KEY; export ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY; " +
        (username === "root" ? "export HOME=/home/user; cd /home/user || exit 96; " : "") +
        "bash -s; status=$?; unset ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY; history -c 2>/dev/null || true; exit $status",
    );
    await command(
      run,
      "ssh",
      [
        "-i",
        key,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=30",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${known}`,
        "-o",
        "LogLevel=ERROR",
        "-p",
        ep.port,
        `${username}@${ep.host}`,
        "bash",
        "-c",
        remote,
      ],
      `${input.token}\n${pub.trim()}\n${input.script}`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
function parseEndpoint(v: string) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(v) || /^([^:]+):(\d+)$/.exec(v);
  if (!m || Number(m[2] ?? 0) < 1 || Number(m[2] ?? 0) > 65535) throw new Error("Invalid SSH endpoint.");
  const host = m[1];
  const port = m[2];
  if (!host || !port) throw new Error("Invalid SSH endpoint.");
  return { host, port };
}
function knownLine(host: string, port: string, key: string) {
  if (/^\S+\s+(ssh-|ecdsa-|sk-)/.test(key)) return key.endsWith("\n") ? key : `${key}\n`;
  if (!/^(ssh-|ecdsa-|sk-)/.test(key)) throw new Error("Invalid SSH host key.");
  return `[${host}]:${port} ${key}\n`;
}
function command(spawnImpl: typeof spawn, file: string, args: string[], stdin: string) {
  return new Promise<void>((resolve, reject) => {
    // Typed as the base ChildProcess, not the stdio-narrowed overload: which @types/node overload
    // that resolves to (and whether it still carries EventEmitter's own members) depends on the
    // exact @types/node version a workspace package without its own pin happens to get hoisted.
    const c: ChildProcess = spawnImpl(file, args, { stdio: ["pipe", "ignore", "pipe"] });
    let pending = "";
    let phase = "ssh";
    let exitCode: string | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      c.kill("SIGKILL");
    }, 600_000);
    c.stderr?.on("data", (d) => {
      // Stream only fixed protocol records; discard all tool stderr, including arbitrary secrets.
      pending += String(d);
      const lines = pending.split("\n");
      pending = (lines.pop() ?? "").slice(-256);
      for (const line of lines) {
        const match =
          /^ARMADA_BUILD_FAILURE (checkout|bun|chromium|harness|init|ownership|credential_cleanup|inline_scan) ([0-9]{1,3})$/.exec(
            line,
          );
        if (match) {
          phase = match[1]!;
          exitCode = match[2];
        }
      }
    });
    c.on("error", () => {
      clearTimeout(timer);
      reject(new GoldenError("build_failed", `${file} could not start. Check server SSH tooling.`));
    });
    c.stdin?.on?.("error", () => {
      /* Close/error owns the sanitized failure. */
    });
    c.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const reason = timedOut ? "timeout" : `exit_${exitCode ?? code ?? "signal"}`;
        console.error(JSON.stringify({ event: "golden_ssh_failed", phase, code: reason }));
        reject(
          new GoldenError(
            "build_failed",
            `Golden build failed during ${phase} (${reason}). Check builder connectivity, permissions and package availability; retry after correction. The previous golden is retained.`,
          ),
        );
      }
    });
    c.stdin?.end(stdin);
  });
}
/** Single-quotes a shell word: close the quote, an escaped literal quote, reopen it. */
export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
