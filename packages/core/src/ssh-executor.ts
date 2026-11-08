import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Provider } from "./provider.ts";

export interface SshExecDeps {
  readPublicKey?: (path: string) => Promise<string>;
  mkdtemp?: typeof mkdtemp;
  rm?: typeof rm;
  writeFile?: typeof writeFile;
  chmod?: typeof chmod;
  spawn?: typeof spawn;
}
/** Secure stdin-only checkout transport. The token is never passed in argv, environment, or a file. */
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
  const key = join(dir, "key");
  const known = join(dir, "known_hosts");
  try {
    await command(run, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], "");
    await fs.chmod(key, 0o600);
    const publicKey = await (deps.readPublicKey ?? ((path: string) => Bun.file(path).text()))(`${key}.pub`);
    const connection = await provider.sshKey({ sandboxId: input.sandboxId, key: publicKey.trim() });
    const endpoint = parseEndpoint(connection.sshEndpoint);
    await fs.writeFile(known, `[${endpoint.host}]:${endpoint.port} ${connection.hostKey}\n`, { mode: 0o600 });
    const args = [
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
      endpoint.port,
      `user@${endpoint.host}`,
      "bash",
      "-s",
    ];
    // Static remote prelude consumes secret line; it does not echo, export, or retain it after checkout.
    const prelude =
      "set +x; IFS= read -r ARMADA_GIT_TOKEN; export ARMADA_GIT_TOKEN; bash -s; unset ARMADA_GIT_TOKEN; history -c 2>/dev/null || true\n";
    await command(run, "ssh", args, `${input.token}\n${prelude}${input.script}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
function parseEndpoint(endpoint: string): { host: string; port: string } {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(endpoint) || /^([^:]+):(\d+)$/.exec(endpoint);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new Error("Invalid SSH endpoint.");
  return { host: m[1]!, port: m[2]! };
}
function command(spawnImpl: typeof spawn, file: string, args: string[], stdin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(file, args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${file} failed${err ? ": " + err.replace(/gh[su]_[A-Za-z0-9_-]+/g, "[redacted]") : ""}`)),
    );
    child.stdin?.end(stdin);
  });
}
