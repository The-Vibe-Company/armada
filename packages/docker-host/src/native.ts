import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DockerMachineCli } from "../../core/src/docker-machine.ts";
import { dockerHostResources } from "../../core/src/docker-resources.ts";
import { VERSION } from "../../core/src/version.ts";
import { type Api, type State, type Store, serverOrigin, validId, validToken } from "./daemon.ts";

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
      let lockName = "daemon.lock";
      if (process.platform === "linux") {
        // A lock from another boot cannot have a surviving process owner. Keep
        // legacy locks for explicit operator inspection. OS flock releases on crashes.
        try {
          await lstat(join(directory, "daemon.lock"));
          throw new Error("Legacy daemon lock requires operator inspection");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
        if (!validId(bootId)) throw new Error("Invalid Linux boot identity");
        lockName = `daemon-${bootId}.lock`;
      }
      const lockPath = join(directory, lockName);
      if (process.platform === "linux") {
        const file = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) {
          await file.close();
          throw new Error("Unsafe daemon lock");
        }
        // The private stdin pipe is a lifetime lease: kernel closes it even on SIGKILL.
        const child = spawn("sh", ["-c", "flock --exclusive --nonblock 3 || exit 1; printf ready; cat >/dev/null"], {
          stdio: ["pipe", "pipe", "ignore", file.fd],
        });
        const ended = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", () => resolve());
        });
        try {
          await new Promise<void>((resolve, reject) => {
            child.stdout?.once("data", () => resolve());
            child.once("error", reject);
            child.once("close", () => reject(new Error("Docker host already running")));
          });
        } catch (error) {
          child.stdin?.end();
          await ended.catch(() => {});
          throw error;
        } finally {
          await file.close();
        }
        return async () => {
          child.stdin?.end();
          await ended;
        };
      }
      const lock = await open(lockPath, "wx", 0o600);
      await lock.close();
      return () => unlink(lockPath);
    },
  };
}

/** A host request the server answered with an error status. */
class HostRequestDenied extends Error {
  constructor(readonly status: number) {
    super("Host request denied");
  }
}

/** Outbound HTTPS only. Redirects cannot forward host credentials to another origin. */
export function httpApi(request: typeof fetch = fetch): Api & {
  unregister(state: State): Promise<boolean>;
  reuseRegistration(state: State, token: string): Promise<{ hostId: string; name: string | null }>;
} {
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
      throw new HostRequestDenied(response.status);
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
    async reuseRegistration(state, token) {
      if (!validToken(token)) throw new Error("Invalid registration token");
      const result = await post(state.server, "reuse-registration", token, { hostId: state.hostId });
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        Object.keys(result).length !== 2 ||
        !("hostId" in result) ||
        result.hostId !== state.hostId ||
        !("name" in result) ||
        !(
          result.name === null ||
          (typeof result.name === "string" &&
            result.name.length > 0 &&
            result.name.length <= 64 &&
            !/[\p{C}]/u.test(result.name))
        )
      )
        throw new Error("Invalid existing host identity");
      return { hostId: state.hostId, name: result.name as string | null };
    },
    async unregister(state) {
      const result = await post(state.server, "unregister", state.hostToken, { installationId: state.installationId });
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        Object.keys(result).length !== 1 ||
        !("revoked" in result) ||
        typeof result.revoked !== "boolean"
      )
        throw new Error("Invalid host revocation response");
      return result.revoked;
    },
    async register(server, token, installationId) {
      return (await post(server, "register", token, { installationId })) as { hostId: string; hostToken: string };
    },
    async poll(state, options) {
      const body = {
        installationId: state.installationId,
        version: VERSION,
        ...(options?.skipSnapshots ? { skipSnapshots: true } : {}),
      };
      try {
        return (await post(state.server, "poll", state.hostToken, {
          ...body,
          resources: dockerHostResources(),
          resourcePolicyVersion: 1,
        })) as Awaited<ReturnType<Api["poll"]>>;
      } catch (error) {
        // Older servers reject the additive resource field before claiming a job.
        if (!(error instanceof HostRequestDenied) || error.status !== 400) throw error;
        return (await post(state.server, "poll", state.hostToken, body)) as Awaited<ReturnType<Api["poll"]>>;
      }
    },
    async result(state, receipt, expired) {
      const body = {
        installationId: state.installationId,
        requestId: receipt.requestId,
        ...(expired ? { expired: true } : { outcome: receipt.outcome }),
        ...(receipt.operation === "buildSnapshot" && receipt.imageId ? { imageId: receipt.imageId } : {}),
      };
      if (expired || !receipt.reason) return void (await post(state.server, "results", state.hostToken, body));
      try {
        await post(state.server, "results", state.hostToken, { ...body, reason: receipt.reason });
      } catch (error) {
        // Only a server older than failure reasons refuses the field (400): the plain outcome is still the machine
        // fact. Any other failure is retried with the reason on the next tick.
        if (!(error instanceof HostRequestDenied) || error.status !== 400) throw error;
        await post(state.server, "results", state.hostToken, body);
      }
    },
  };
}

/** Never a shell, never inherited output; inspect can contain secrets. */
export const dockerCli: DockerMachineCli = {
  run(argv, stdin, options) {
    // Buildx is a separate client process: its stdin may be a socket that cannot be reopened as /dev/stdin.
    // A scoped environment secret is consumed by BuildKit, not Dockerfile ENV/ARG or the image.
    const env = { ...process.env };
    delete env.ARMADA_SNAPSHOT_GITHUB_TOKEN;
    if (options?.githubBuildToken !== undefined) {
      if (argv[0] !== "build") return Promise.reject(new Error("Build secret is only valid for image builds."));
      env.ARMADA_SNAPSHOT_GITHUB_TOKEN = options.githubBuildToken;
    }
    return new Promise((resolve, reject) => {
      const child = spawn("docker", [...argv], { stdio: ["pipe", "pipe", "ignore"], env });
      let output = "";
      let bytes = 0;
      let failed = false;
      const fail = () => {
        failed = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(fail, options?.timeoutMs ?? 30_000);
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
