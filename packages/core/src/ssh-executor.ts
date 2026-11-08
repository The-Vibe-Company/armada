import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    await command(run, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], "", input.token);
    await fs.chmod(key, 0o600);
    const pub = await (deps.readPublicKey ?? ((p: string) => Bun.file(p).text()))(`${key}.pub`);
    const c = await provider.sshKey({ sandboxId: input.sandboxId, key: pub.trim() });
    const ep = parseEndpoint(c.sshEndpoint);
    await fs.writeFile(known, knownLine(ep.host, ep.port, c.hostKey), { mode: 0o600 });
    // ssh joins its command argv with spaces before the remote shell parses it. Keep this one
    // shell-quoted argument so semicolons cannot escape bash -c and turn `set +x` into a command.
    // The checkout script itself carries the cleanup trap; do not exec, which would discard it.
    const remote = shellQuote(
      "set +x; IFS= read -r ARMADA_GIT_TOKEN; IFS= read -r ARMADA_SSH_PUBLIC_KEY; export ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY; bash -s; status=$?; unset ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY; history -c 2>/dev/null || true; exit $status",
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
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${known}`,
        "-o",
        "LogLevel=ERROR",
        "-p",
        ep.port,
        `user@${ep.host}`,
        remote,
      ],
      `${input.token}\n${pub.trim()}\n${input.script}`,
      input.token,
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
function command(spawnImpl: typeof spawn, file: string, args: string[], stdin: string, token: string) {
  return new Promise<void>((resolve, reject) => {
    const c = spawnImpl(file, args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    const timer = setTimeout(() => c.kill("SIGKILL"), 600_000);
    c.stderr?.on("data", (d) => {
      if (err.length < 4096) err += String(d);
    });
    c.on("error", reject);
    c.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${file} failed${err ? `: ${redact(err, token)}` : ""}`));
    });
    c.stdin?.end(stdin);
  });
}
function redact(v: string, t: string) {
  return v
    .replaceAll(t, "[redacted]")
    .replace(/gh[suo]_[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 4096);
}
function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}
