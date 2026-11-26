import { chmod, lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  installRuntimeArtifact,
  type RuntimeArtifact,
  readSharedArtifact,
} from "../../agent-runtime/src/artifact-cache.ts";
import type { createDockerMachineExecutor, DockerMachineRequest } from "../../core/src/docker-machine.ts";

type Machine = Pick<ReturnType<typeof createDockerMachineExecutor>, "installRuntime">;

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function validServerOrigin(serverUrl: string) {
  const server = new URL(serverUrl);
  if (
    server.protocol !== "https:" ||
    server.username ||
    server.password ||
    server.pathname !== "/" ||
    server.search ||
    server.hash
  )
    throw new Error("Invalid runtime artifact server");
  return server.origin;
}

function validRuntimeArtifact(artifact: RuntimeArtifact) {
  return (
    SHA256_HEX.test(artifact.sha256) &&
    Number.isSafeInteger(artifact.bytes) &&
    artifact.bytes > 0 &&
    artifact.bytes <= MAX_ARTIFACT_BYTES
  );
}

function asUint8Array(bytes: Uint8Array) {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function readVerifiedRuntimeBytes(
  input: { serverUrl: string; cacheDir: string; artifact: RuntimeArtifact },
  request: typeof fetch,
) {
  const origin = validServerOrigin(input.serverUrl);
  if (!isAbsolute(input.cacheDir) || !validRuntimeArtifact(input.artifact)) throw new Error("Invalid runtime artifact");
  await mkdir(input.cacheDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(input.cacheDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077)
    throw new Error("Runtime cache directory is not private");
  const target = join(input.cacheDir, input.artifact.sha256);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Invalid runtime cache entry");
  if (existing?.size === input.artifact.bytes) {
    const cached = await readSharedArtifact(input.cacheDir, input.artifact);
    if (cached) {
      if ((existing.mode & 0o777) !== 0o700) await chmod(target, 0o700);
      return asUint8Array(cached);
    }
  }
  const path = await installRuntimeArtifact(
    { serverUrl: origin, cacheDir: input.cacheDir, artifact: input.artifact },
    request,
  );
  const downloaded = await readSharedArtifact(input.cacheDir, input.artifact);
  if (!downloaded || path !== target) throw new Error("Runtime artifact verification failed");
  return asUint8Array(downloaded);
}

export function dockerRuntimeInstaller(machine: Machine, request: typeof fetch = fetch) {
  return async (input: {
    machine: DockerMachineRequest;
    serverUrl: string;
    cacheDir: string;
    artifact: RuntimeArtifact;
  }) => {
    try {
      const bytes = await readVerifiedRuntimeBytes(input, request);
      await machine.installRuntime(input.machine, bytes);
    } catch {
      throw new Error("Docker runtime installation failed");
    }
  };
}

const START_RUNTIME =
  '[ "$(command -v printf)" = printf ] || exit 1; payload=$(cat) || exit 1; (trap "" HUP; command printf "%s" "$payload" | "$1" dialout >/dev/null 2>&1) </dev/null >/dev/null 2>&1 &';

function startSharedWarm(warm: ((runtime: string) => unknown) | undefined, runtime: string) {
  if (!warm) return;
  try {
    void Promise.resolve(warm(runtime)).catch(() => {});
  } catch {}
}

export function dockerRuntimeStarter(
  machine: Machine & Pick<ReturnType<typeof createDockerMachineExecutor>, "bootstrap">,
  options: {
    serverUrl: string;
    cacheDir: string;
    warmSharedArtifacts?: (runtime: string) => unknown;
  },
  request: typeof fetch = fetch,
) {
  const install = dockerRuntimeInstaller(machine, request);
  return async (
    target: DockerMachineRequest,
    bootstrap: import("../../core/src/docker-host-job.ts").BootstrapDescriptor,
  ) => {
    try {
      const origin = validServerOrigin(options.serverUrl);
      if (
        bootstrap.serverUrl !== origin ||
        !/^armada_enrol_[a-f0-9]{64}$/.test(bootstrap.enrolmentToken) ||
        !isAbsolute(options.cacheDir) ||
        !validRuntimeArtifact(bootstrap.artifact)
      )
        throw new Error("Invalid runtime bootstrap");
      startSharedWarm(options.warmSharedArtifacts, bootstrap.artifact.sha256);
      await install({
        machine: target,
        serverUrl: origin,
        cacheDir: options.cacheDir,
        artifact: bootstrap.artifact,
      });
      await machine.bootstrap(target, {
        command: ["/bin/sh", "-c", START_RUNTIME, "armada-runtime-start", "/home/user/armada-runtime"],
        stdin: JSON.stringify({ serverUrl: origin, enrolmentToken: bootstrap.enrolmentToken }),
      });
    } catch {
      throw new Error("Docker runtime bootstrap failed");
    }
  };
}
