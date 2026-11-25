import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DOCKER_HOST_PROTOCOL, DOCKER_HOST_PROTOCOL_HEADER } from "../../core/src/docker-host-protocol.ts";
import {
  DOCKER_HOST_MACHINE_BOOTSTRAP_HEADER,
  DOCKER_HOST_PREFER_STARTUP_HEADER,
  DOCKER_HOST_RESTORE_RECOVERY_HEADER,
  type DockerHostPollRequest,
  type DockerHostPollResponse,
  type DockerHostResultRequest,
} from "../../core/src/docker-host-wire.ts";
import {
  createDockerMachineExecutor,
  type DockerMachineCli,
  DockerMachineError,
  type DockerMachineRequest,
} from "../../core/src/docker-machine.ts";
import { DOCKER_OUTPUT_DIRECTORY_MISSING } from "../../core/src/docker-output-archive.ts";
import { type DockerHostResources, dockerHostResources } from "../../core/src/docker-resources.ts";
import { OUTPUT_ARCHIVE_LIMIT } from "../../core/src/sandbox-output-limits.ts";
import { VERSION } from "../../core/src/version.ts";
import { createDockerContainerInventory } from "./container-inventory.ts";
import { type Api, compactReceipts, type State, type Store, serverOrigin, validId, validToken } from "./daemon.ts";

const MAX_STATE_BYTES = 16 * 1024 * 1024;
export async function fileStore(directory: string) {
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
  const store: Store & { lock(): Promise<() => Promise<void>>; exists(): Promise<boolean> } = {
    load,
    exists,
    async save(state) {
      compactReceipts(state);
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error("Host state capacity reached");
      if (await exists()) await load();
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
  return store;
}
class HostRequestDenied extends Error {
  constructor(readonly status: number) {
    super("Host request denied");
  }
}
export function hostFailureClass(error: unknown) {
  if (error instanceof HostRequestDenied) return "HostRequestDenied";
  if (error instanceof DockerMachineError) return "DockerMachineError";
  if (error instanceof DOMException) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return error.name;
    return "DOMException";
  }
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof TypeError) return "TypeError";
  return error instanceof Error ? "Error" : "Unknown";
}

type InventoryPhase = "inventory_scan" | "inventory_upload";
export function httpApi(
  request: typeof fetch = fetch,
  resources?: (state: State) => Promise<DockerHostResources>,
  diskFreeBytes?: () => Promise<number | null>,
  stoppedBytes?: (state: State) => Promise<number | null>,
  inventory?: { cli: DockerMachineCli; failed(phase: InventoryPhase, error: unknown): void },
) {
  let stopIdentitySupported = false;
  let stopAbsenceSupported = false;

  async function post(
    server: string,
    endpoint: string,
    token: string,
    body: unknown,
    timeoutMs = 8_000,
    signal?: AbortSignal,
    onResponse?: (response: Response) => void,
    headers?: Record<string, string>,
  ) {
    const response = await request(`${serverOrigin(server)}/api/docker-host/${endpoint}`, {
      method: "POST",
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        [DOCKER_HOST_PROTOCOL_HEADER]: String(DOCKER_HOST_PROTOCOL),
        ...(endpoint === "poll"
          ? {
              "x-armada-docker-host-delete-physical": "1",
              "x-armada-docker-host-restore": "1",
              [DOCKER_HOST_RESTORE_RECOVERY_HEADER]: "1",
              [DOCKER_HOST_MACHINE_BOOTSTRAP_HEADER]: "1",
            }
          : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HostRequestDenied(response.status);
    }
    onResponse?.(response);
    if (endpoint === "results" || endpoint === "container-inventory") {
      await response.body?.cancel();
      return undefined;
    }
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
  function postResult(state: State, body: DockerHostResultRequest & { retained?: true }) {
    return post(state.server, "results", state.hostToken, body);
  }

  const inventoryStop = new AbortController();
  let inventoryReport: Promise<void> | undefined;
  let nextInventoryAt = 0;
  async function reportInventory(reporter: NonNullable<typeof inventory>, state: State, deploymentId: string) {
    const signal = inventoryStop.signal;
    let phase: InventoryPhase = "inventory_scan";
    try {
      const containers = await Array.fromAsync(
        createDockerContainerInventory(reporter.cli, state, deploymentId).listInventory(signal),
      );
      signal.throwIfAborted();
      phase = "inventory_upload";
      await post(
        state.server,
        "container-inventory",
        state.hostToken,
        { installationId: state.installationId, containers },
        undefined,
        signal,
      );
    } catch (error) {
      if (!signal.aborted) reporter.failed(phase, error);
    }
  }

  const api: Api & {
    stopInventory(): Promise<void>;
    retainedOutputs(
      state: State,
      requestId: string,
      read: () => Promise<Uint8Array<ArrayBuffer> | null>,
    ): Promise<void>;
    unregister(state: State): Promise<boolean>;
    reuseRegistration(state: State, token: string): Promise<{ hostId: string; name: string | null }>;
  } = {
    async stopInventory() {
      inventoryStop.abort();
      await inventoryReport;
    },
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
      async function poll(body: DockerHostPollRequest, timeoutMs?: number) {
        let retainedStopProof = false;
        const result = (await post(
          state.server,
          "poll",
          state.hostToken,
          body,
          timeoutMs,
          undefined,
          (response) => {
            stopIdentitySupported = response.headers.get("x-armada-docker-stop-identity") === "1";
            stopAbsenceSupported = response.headers.get("x-armada-docker-stop-absence") === "1";
            retainedStopProof = response.headers.get("x-armada-docker-retained-stop") === "1";
          },
          options?.preferStartup ? { [DOCKER_HOST_PREFER_STARTUP_HEADER]: "1" } : undefined,
        )) as DockerHostPollResponse;
        if (
          inventory &&
          !inventoryStop.signal.aborted &&
          result?.containerInventory === 1 &&
          !inventoryReport &&
          performance.now() >= nextInventoryAt
        ) {
          const deploymentId =
            result.containerInventoryDeploymentId ??
            `${serverOrigin(state.server)}/${state.hostId}/${state.installationId}`;
          inventoryReport = reportInventory(inventory, state, deploymentId).finally(() => {
            nextInventoryAt = performance.now() + 60_000;
            inventoryReport = undefined;
          });
        }
        return { ...result, retainedStopProof: retainedStopProof ? (true as const) : undefined };
      }

      const body = {
        installationId: state.installationId,
        version: VERSION,
        ...(options?.skipSnapshots && options.waitSeconds === undefined ? { skipSnapshots: true as const } : {}),
      };
      const retention = {
        retentionSeconds: state.retentionSeconds ?? 86400,
        nextCleanupAt: (state.retention ?? [])
          .filter((entry) => !entry.deleted)
          .reduce<string | null>((next, entry) => {
            const at = new Date(entry.deadline).toISOString();
            return next === null || at < next ? at : next;
          }, null),
        deadlines: (state.retention ?? [])
          .filter((entry) => !entry.deleted)
          .map((entry) => ({
            sandboxId: entry.request.sandboxId,
            generation: entry.request.generation,
            deadline: new Date(entry.deadline).toISOString(),
          })),
      };
      const disk = diskFreeBytes ? { diskFreeBytes: await diskFreeBytes() } : {};
      const stopped = stoppedBytes ? { stoppedSandboxBytes: await stoppedBytes(state) } : {};
      const sampledResources = resources ? await resources(state) : dockerHostResources();
      const waitSeconds = options?.waitSeconds;
      return await poll(
        {
          ...body,
          resumeClaimProtocol: 1,
          ...retention,
          ...disk,
          ...stopped,
          resources: sampledResources,
          resourcePolicyVersion: 1,
          ...(waitSeconds === undefined ? {} : { waitSeconds, running: [...(options?.running ?? [])] }),
        },
        waitSeconds === undefined ? undefined : waitSeconds * 1000 + 8_000,
      );
    },
    async claim(state, requestId, accepted) {
      await postResult(state, {
        installationId: state.installationId,
        requestId,
        claimed: accepted,
      });
    },
    async cleaned(state, requestId, reason) {
      await postResult(state, {
        installationId: state.installationId,
        requestId,
        cleaned: true,
        ...(reason ? { cleanupReason: reason } : {}),
      });
    },
    async retainedOutputs(state, requestId, read) {
      async function send(body?: Uint8Array<ArrayBuffer>) {
        const response = await request(`${serverOrigin(state.server)}/api/docker-host/retained-outputs`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(45_000),
          headers: {
            authorization: `Bearer ${state.hostToken}`,
            [DOCKER_HOST_PROTOCOL_HEADER]: String(DOCKER_HOST_PROTOCOL),
            "x-armada-installation-id": state.installationId,
            "x-armada-request-id": requestId,
            ...(body ? { "content-type": "application/x-tar" } : {}),
          },
          ...(body ? { body } : {}),
        });
        await response.body?.cancel();
        if (response.status !== 204 && response.status !== 202) throw new HostRequestDenied(response.status);
        return response.status;
      }
      if ((await send()) === 204) return;
      const archive = await read();
      if (archive && (await send(archive)) !== 204) throw new Error("Retained output upload not acknowledged");
    },
    async result(state, receipt, expired, retained) {
      if (!expired && !receipt.outcome) throw new Error("Missing host receipt outcome");
      const machineId =
        !expired &&
        receipt.outcome === "completed" &&
        (receipt.operation === "create" ||
          receipt.operation === "restore" ||
          (receipt.operation === "stop" && stopIdentitySupported))
          ? receipt.machineId
          : undefined;
      const body: DockerHostResultRequest & { retained?: true } = {
        installationId: state.installationId,
        requestId: receipt.requestId,
        ...(!expired && retained && receipt.operation === "stop" && receipt.outcome === "failed" ? { retained } : {}),
        ...(expired ? { expired: true } : { outcome: receipt.outcome! }),
        ...(machineId === undefined ? {} : { machineId }),
        ...(!expired &&
        stopAbsenceSupported &&
        receipt.operation === "stop" &&
        receipt.outcome === "completed" &&
        receipt.absentMachineId
          ? { absentMachineId: receipt.absentMachineId }
          : {}),
        ...(receipt.operation === "buildSnapshot" && receipt.imageId ? { imageId: receipt.imageId } : {}),
      };
      const baselineVersion = receipt.operation === "buildSnapshot" ? receipt.baselineVersion : undefined;
      const baselineTool = receipt.operation === "buildSnapshot" ? receipt.baselineTool : undefined;
      const missingRefIndex = receipt.operation === "buildSnapshot" ? receipt.missingRefIndex : undefined;
      if (expired || (!receipt.reason && baselineVersion === undefined)) return void (await postResult(state, body));
      await postResult(state, {
        ...body,
        ...(receipt.reason ? { reason: receipt.reason } : {}),
        ...(baselineVersion === undefined ? {} : { baselineVersion }),
        ...(baselineTool === undefined ? {} : { baselineTool }),
        ...(missingRefIndex === undefined ? {} : { missingRefIndex }),
      });
    },
  };
  return api;
}

export async function observeRetainedStop(
  options: Parameters<typeof createDockerMachineExecutor>[0],
  request: DockerMachineRequest,
) {
  let exitedContainer = false;
  const executor = createDockerMachineExecutor({
    ...options,
    cli: {
      async run(args, stdin, runOptions) {
        const result = await options.cli.run(args, stdin, runOptions);
        if (args[0] === "container" && args[1] === "inspect" && result.exitCode === 0) {
          const rows: unknown = JSON.parse(result.stdout);
          const container = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
          exitedContainer =
            typeof container?.Id === "string" &&
            /^[a-f0-9]{64}$/.test(container.Id) &&
            container.State?.Status === "exited" &&
            container.State.Running === false;
        }
        return result;
      },
    },
  });
  return (await executor.isStopped(request)) && exitedContainer;
}
export const dockerCli: DockerMachineCli = {
  run(argv, stdin, options) {
    const env = { ...process.env };
    delete env.ARMADA_SNAPSHOT_GITHUB_TOKEN;
    if (options?.githubBuildToken !== undefined) {
      if (argv[0] !== "build") return Promise.reject(new Error("Build secret is only valid for image builds."));
      env.ARMADA_SNAPSHOT_GITHUB_TOKEN = options.githubBuildToken;
    }
    return new Promise((resolve, reject) => {
      const captureBuildDiagnostic = options?.githubBuildToken !== undefined;
      const child = spawn("docker", [...argv], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
      let buildStderr = "";
      child.stderr.on("data", (data: Buffer) => {
        if (!captureBuildDiagnostic) return;
        buildStderr = (buildStderr + data.toString("utf8")).slice(-32768);
      });
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
        else resolve({ exitCode: code, stdout: output, ...(captureBuildDiagnostic ? { stderr: buildStderr } : {}) });
      });
      child.stdin.end(stdin);
    });
  },
};
export async function readDockerOutputArchive(argv: readonly string[]) {
  const child = Bun.spawn(["docker", ...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    signal: AbortSignal.timeout(20_000),
    killSignal: "SIGKILL",
  });
  const reader = child.stdout.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > OUTPUT_ARCHIVE_LIMIT) throw new Error("Docker output archive exceeds its byte budget");
      parts.push(next.value);
    }
    const exitCode = await child.exited;
    if (exitCode === DOCKER_OUTPUT_DIRECTORY_MISSING && size === 0) return null;
    if (exitCode !== 0) throw new Error("Docker output archive unavailable");
    return Buffer.concat(parts, size);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await reader.cancel().catch(() => {});
    await child.exited;
  }
}
