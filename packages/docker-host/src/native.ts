import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DockerMachineCli } from "../../core/src/docker-machine.ts";
import { type Api, type Job, type State, type Store, serverOrigin, validId, validToken } from "./daemon.ts";

const MAX_STATE_BYTES = 16 * 1024 * 1024;

/** Private atomic state and an exclusive process lock; abandoned locks require operator intervention. */
export async function fileStore(
  directory: string,
): Promise<Store & { lock(): Promise<() => Promise<void>>; exists(): Promise<boolean> }> {
  if (!isAbsolute(directory)) throw new Error("State directory must be absolute");
  directory = resolve(directory);
  for (let path = directory; ; path = dirname(path)) {
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("Unsafe state directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (path === dirname(path)) break;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700 || dir.uid !== process.getuid?.())
    throw new Error("Unsafe state directory");
  const path = join(directory, "state.json");
  async function exists() {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async function load() {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== process.getuid?.() ||
        stat.size > MAX_STATE_BYTES
      )
        throw new Error("Unsafe host state");
      const state: State = JSON.parse(await file.readFile("utf8"));
      if (
        serverOrigin(state.server) !== state.server ||
        !validId(state.installationId) ||
        !validId(state.hostId) ||
        !validToken(state.hostToken) ||
        !Array.isArray(state.receipts)
      )
        throw new Error("Invalid host state");
      return state;
    } finally {
      await file.close();
    }
  }
  return {
    load,
    exists,
    async save(state) {
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error("Host state capacity reached");
      if (await exists()) await load(); // Refuse unsafe existing configuration rather than replacing it.
      const temporary = join(directory, `.state-${crypto.randomUUID()}`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(serialized);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      const folder = await open(directory, constants.O_RDONLY);
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
    },
    async lock() {
      const lockPath = join(directory, "daemon.lock");
      const lock = await open(lockPath, "wx", 0o600);
      await lock.close();
      return () => unlink(lockPath);
    },
  };
}

/** Outbound HTTPS only. Redirects cannot forward host credentials to another origin. */
export function httpApi(request: typeof fetch = fetch): Api {
  async function post(server: string, endpoint: string, token: string, body: unknown): Promise<unknown> {
    const response = await request(`${serverOrigin(server)}/api/docker-host/${endpoint}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Host request denied");
    }
    if (endpoint === "results") {
      await response.body?.cancel();
      return undefined;
    }
    // Bound protocol output as well as Docker inspect output; neither is ever logged.
    if (!response.body) throw new Error("Invalid host response");
    let size = 0;
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 65_536) throw new Error("Invalid host response");
        parts.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  }
  return {
    async register(server, token, installationId) {
      return (await post(server, "register", token, { installationId })) as { hostId: string; hostToken: string };
    },
    async poll(state) {
      return (await post(state.server, "poll", state.hostToken, { installationId: state.installationId })) as {
        job: Job | null;
      };
    },
    async result(state, receipt, expired) {
      await post(state.server, "results", state.hostToken, {
        installationId: state.installationId,
        requestId: receipt.requestId,
        ...(expired ? { expired: true } : { outcome: receipt.outcome }),
      });
    },
  };
}

/** Never a shell, never inherited output; inspect can contain secrets. */
export const dockerCli: DockerMachineCli = {
  run(argv, stdin) {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", [...argv], { stdio: ["pipe", "pipe", "ignore"] });
      let output = "";
      let bytes = 0;
      let failed = false;
      const fail = () => {
        failed = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(fail, 30_000);
      child.stdout.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > 1024 * 1024) fail();
        else output += data.toString("utf8");
      });
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("Docker command failed"));
      });
      child.stdin.on("error", fail);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failed || code === null) reject(new Error("Docker command failed"));
        else resolve({ exitCode: code, stdout: output });
      });
      child.stdin.end(stdin);
    });
  },
};
