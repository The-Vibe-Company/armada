import type { DockerHostJob } from "./docker-host-job.ts";
import {
  DOCKER_LOCAL_IMAGE_LABELS,
  type DockerSnapshotBinding,
  isDockerImageReference,
  parseDockerSnapshotBinding,
} from "./docker-image.ts";
import { DOCKER_OUTPUT_ARCHIVE } from "./docker-output-archive.ts";
import { type DockerSandboxLimits, dockerHostResources, dockerResourceArgs } from "./docker-resources.ts";
import { buildDockerSnapshot } from "./docker-snapshot-build.ts";
import { officialSandboxImage } from "./official-sandbox-image.ts";
import { SHARED_ARTIFACT_CACHE_PATH } from "./shared-artifact-cache.ts";

/** Direct argv execution only; adapters must never invoke a shell or log stdin/output. */
export interface DockerMachineCli {
  /** `timeoutMs` lengthens the CLI's default bound for a slow command (an image pull). */
  run(
    argv: readonly string[],
    stdin?: string | Uint8Array,
    options?: { timeoutMs?: number; githubBuildToken?: string },
  ): Promise<{ exitCode: number; stdout: string; stderr?: string }>;
}

/**
 * How long a host may take to fetch an image it does not have yet: half the launch's 10-minute deadline, leaving the
 * rest for the container and the runtime. The pull blocks only its own sandbox; the daemon keeps taking other jobs.
 */
export const DOCKER_IMAGE_PULL_TIMEOUT_MS = 5 * 60_000;

export interface DockerMachineRequest {
  sandboxId: string;
  generation: string;
  /** Host-approved digest-pinned image, not a remote caller's arbitrary image. */
  image: string;
  ttlSeconds: number;
  /** Frozen absolute UTC deadline; omitted requests retain relative TTL behavior. */
  expiresAt?: number;
  snapshot?: DockerSnapshotBinding;
}

export class DockerMachineError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "docker_failed"
      | "image_unavailable"
      | "ownership_mismatch"
      | "expired"
      | "not_found",
  ) {
    super(`Docker machine ${code}`);
    this.name = "DockerMachineError";
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dockerContainerId = /^[a-f0-9]{64}$/;
const prefix = "dev.armada.machine.";
type Row = Record<string, unknown>;

/** A host-local image ID (`sha256:<hex>`), as opposed to a registry reference such as `sha256:base@sha256:<hex>`. */
const isLocalImage = (image: string) => image.startsWith("sha256:") && !image.includes("@");

function fail(code: DockerMachineError["code"]): never {
  throw new DockerMachineError(code);
}

function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("ownership_mismatch");
  return value as Row;
}

/**
 * Internal machine-only executor. Callers serialize each generation across host processes and
 * persist its request before allocation. TTL enforcement requires a host scheduler calling
 * stopIfExpired; Docker supplies no timer. This is not a provider or remote arbitrary-exec API.
 * Runtime installation repairs fresh workspace ownership using a fixed public-artifact archive.
 * Artifact verification belongs to the caller; installation is not a remote execution API.
 */
export function createDockerMachineExecutor(options: {
  installationId: string;
  hostId: string;
  cli: DockerMachineCli;
  now: () => number;
  readArchive?: (argv: readonly string[]) => Promise<Uint8Array<ArrayBuffer> | null>;
  limits?: () => DockerSandboxLimits;
  /**
   * Host directory of verified digest-named public artifacts, bind-mounted read-only at
   * SHARED_ARTIFACT_CACHE_PATH into new containers (#2562). The mount is an optimization:
   * `ensure` (re)creates the directory before each create/start and a create that cannot
   * bind it retries without it. Ownership always accepts this exact read-only bind, so a
   * failed preparation never strands stop/delete; containers without it stay owned too.
   */
  sharedArtifacts?: { dir: string; ensure(): Promise<boolean> };
}) {
  if (!uuid.test(options.installationId) || !uuid.test(options.hostId)) fail("invalid_request");
  const shared = options.sharedArtifacts;
  if (shared !== undefined && (!shared.dir.startsWith("/") || /[,"=\0\n\r]/.test(shared.dir))) fail("invalid_request");
  const ensureShared = async () => (shared ? await shared.ensure().catch(() => false) : false);

  async function run(argv: readonly string[], stdin?: string | Uint8Array) {
    try {
      return await options.cli.run(argv, stdin);
    } catch {
      return fail("docker_failed");
    }
  }

  async function checked(argv: readonly string[], stdin?: string | Uint8Array) {
    const result = await run(argv, stdin);
    if (result.exitCode !== 0) fail("docker_failed");
    return result.stdout;
  }

  function context(request: DockerMachineRequest) {
    if (
      !uuid.test(request.sandboxId) ||
      !uuid.test(request.generation) ||
      !isDockerImageReference(request.image) ||
      !Number.isInteger(request.ttlSeconds) ||
      request.ttlSeconds < 1 ||
      request.ttlSeconds > 86_400 ||
      (request.expiresAt !== undefined &&
        (!Number.isSafeInteger(request.expiresAt) ||
          request.expiresAt <= 0 ||
          request.expiresAt > 8_640_000_000_000_000))
    )
      fail("invalid_request");
    if (request.snapshot !== undefined) {
      parseDockerSnapshotBinding(request.snapshot);
      if (request.image.includes("@")) fail("invalid_request");
    }
    const name = `armada-${options.installationId}-${options.hostId}-${request.sandboxId}-${request.generation}`;
    return {
      containerName: name,
      volumeName: `${name}-home`,
      labels: {
        [`${prefix}installation`]: options.installationId,
        [`${prefix}host`]: options.hostId,
        [`${prefix}sandbox`]: request.sandboxId,
        [`${prefix}generation`]: request.generation,
        [`${prefix}image`]: request.image,
        [`${prefix}ttl-seconds`]: String(request.ttlSeconds),
        ...(request.snapshot
          ? {
              [`${prefix}snapshot`]: request.snapshot.id,
              [`${prefix}snapshot-owner`]: request.snapshot.ownerId,
              [`${prefix}snapshot-visibility`]: request.snapshot.visibility,
            }
          : {}),
        ...(request.expiresAt === undefined ? {} : { [`${prefix}absolute-expiry`]: String(request.expiresAt) }),
      },
    };
  }

  async function inspect(kind: "container" | "volume", name: string): Promise<Row | null> {
    // Nonzero inspect does not prove absence: permission and daemon failures also return nonzero.
    const listed = await checked([
      kind,
      "ls",
      ...(kind === "container" ? ["--all"] : []),
      "--format",
      kind === "container" ? "{{json .Names}}" : "{{json .Name}}",
    ]);
    if (listed.trim() === "") return null;
    try {
      const names = listed
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (names.some((entry) => typeof entry !== "string")) fail("ownership_mismatch");
      if (!names.includes(name)) return null;
      if (names.filter((entry) => entry === name).length !== 1) fail("ownership_mismatch");
    } catch {
      fail("ownership_mismatch");
    }
    const raw = await checked([kind, "inspect", name]);
    try {
      const rows: unknown = JSON.parse(raw);
      if (!Array.isArray(rows) || rows.length !== 1) fail("ownership_mismatch");
      return object(rows[0]);
    } catch {
      return fail("ownership_mismatch");
    }
  }

  function expiry(raw: unknown, expected: Record<string, string>, request: DockerMachineRequest) {
    const labels = object(raw);
    for (const [key, value] of Object.entries(expected)) if (labels[key] !== value) fail("ownership_mismatch");
    const created = Number(labels[`${prefix}created-at`]);
    const end = Number(labels[`${prefix}expires-at`]);
    if (
      !Number.isSafeInteger(created) ||
      created < 0 ||
      !Number.isSafeInteger(end) ||
      (request.expiresAt === undefined
        ? labels[`${prefix}absolute-expiry`] !== undefined || end !== created + request.ttlSeconds * 1000
        : created >= end || end !== Math.min(request.expiresAt, created + request.ttlSeconds * 1000))
    )
      fail("ownership_mismatch");
    return end;
  }

  async function owned(request: DockerMachineRequest) {
    const ctx = context(request);
    const container = await inspect("container", ctx.containerName);
    const volume = await inspect("volume", ctx.volumeName);
    let expiresAt: number | undefined;
    if (volume) {
      if (
        volume.Name !== ctx.volumeName ||
        volume.Driver !== "local" ||
        Object.keys(object(volume.Options ?? {})).length !== 0
      )
        fail("ownership_mismatch");
      expiresAt = expiry(volume.Labels, ctx.labels, request);
    }
    if (container) {
      const config = object(container.Config);
      const host = object(container.HostConfig);
      const mounts = container.Mounts;
      if (
        container.Name !== `/${ctx.containerName}` ||
        config.Image !== request.image ||
        config.User !== "1000:1000" ||
        host.Privileged !== false ||
        !Array.isArray(mounts) ||
        mounts.length < 1 ||
        mounts.length > (shared === undefined ? 1 : 2)
      )
        fail("ownership_mismatch");
      const home = mounts.filter((entry) => object(entry).Type !== "bind");
      const binds = mounts.filter((entry) => object(entry).Type === "bind");
      if (home.length !== 1) fail("ownership_mismatch");
      // The only accepted extra mount is this host's own read-only shared artifact cache.
      for (const entry of binds) {
        const bind = object(entry);
        if (bind.Source !== shared?.dir || bind.Destination !== SHARED_ARTIFACT_CACHE_PATH || bind.RW !== false)
          fail("ownership_mismatch");
      }
      const mount = object(home[0]);
      if (
        mount.Type !== "volume" ||
        mount.Name !== ctx.volumeName ||
        mount.Destination !== "/home/user" ||
        mount.RW !== true
      )
        fail("ownership_mismatch");
      if (!volume || expiresAt !== expiry(config.Labels, ctx.labels, request)) fail("ownership_mismatch");
    }
    return { ...ctx, container, volume, expiresAt };
  }

  function now() {
    const value = options.now();
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid_request");
    return value;
  }

  async function approveLocalImage(image: string, snapshot?: DockerSnapshotBinding) {
    if (!isLocalImage(image)) return;
    const raw = await checked(["image", "inspect", image]);
    try {
      const rows: unknown = JSON.parse(raw);
      if (!Array.isArray(rows) || rows.length !== 1) fail("ownership_mismatch");
      const row = object(rows[0]);
      const labels = object(object(row.Config).Labels);
      if (
        row.Id !== image ||
        labels[DOCKER_LOCAL_IMAGE_LABELS.installation] !== options.installationId ||
        labels[DOCKER_LOCAL_IMAGE_LABELS.host] !== options.hostId ||
        (snapshot
          ? labels[DOCKER_LOCAL_IMAGE_LABELS.scope] !== snapshot.visibility ||
            labels[DOCKER_LOCAL_IMAGE_LABELS.owner] !== snapshot.ownerId ||
            labels[DOCKER_LOCAL_IMAGE_LABELS.snapshot] !== snapshot.id
          : labels[DOCKER_LOCAL_IMAGE_LABELS.scope] !== "org")
      )
        fail("ownership_mismatch");
    } catch {
      fail("ownership_mismatch");
    }
  }

  async function create(request: DockerMachineRequest) {
    let state = await owned(request);
    const absoluteCreationTime = request.expiresAt === undefined ? undefined : now();
    if (
      absoluteCreationTime !== undefined &&
      request.expiresAt !== undefined &&
      request.expiresAt <= absoluteCreationTime
    )
      fail("expired");
    // An immutable local ID alone is not authorization to consume another host's cache.
    // Approval is checked before any new allocation, never required for retained cleanup/resume.
    if (!state.container) await approveLocalImage(request.image, request.snapshot);
    if (!state.volume) {
      const created = absoluteCreationTime ?? now();
      const labels = {
        ...state.labels,
        [`${prefix}created-at`]: String(created),
        [`${prefix}expires-at`]: String(
          Math.min(request.expiresAt ?? Number.POSITIVE_INFINITY, created + request.ttlSeconds * 1000),
        ),
      };
      await checked(["volume", "create", "--driver", "local", ...labelArgs(labels), state.volumeName]);
      state = await owned(request);
      if (!state.volume) fail("docker_failed");
    }
    if (state.expiresAt === undefined) fail("ownership_mismatch");
    if (state.expiresAt <= now()) fail("expired");
    if (!state.container) {
      // An image the host does not have is fetched first, with a pull's own bound, so a failure says the image could
      // not be fetched instead of a generic Docker failure (#1507). A local image ID is never pulled: it was approved
      // above, and a missing one has no registry to come from (#1523).
      if (
        !isLocalImage(request.image) &&
        (await run(["image", "inspect", "--format", "{{.Id}}", request.image])).exitCode !== 0
      ) {
        let pulled = false;
        try {
          const pull = ["image", "pull", "--quiet", request.image];
          pulled = (await options.cli.run(pull, undefined, { timeoutMs: DOCKER_IMAGE_PULL_TIMEOUT_MS })).exitCode === 0;
        } catch {
          // A pull that could not run or outlived its bound is a fetch failure too.
        }
        if (!pulled) fail("image_unavailable");
      }
      const createArgs = (mountShared: boolean) => [
        "container",
        "create",
        ...dockerResourceArgs(dockerHostResources(), options.limits?.()),
        "--name",
        state.containerName,
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--mount",
        `type=volume,src=${state.volumeName},dst=/home/user`,
        ...(mountShared && shared
          ? ["--mount", `type=bind,src=${shared.dir},dst=${SHARED_ARTIFACT_CACHE_PATH},readonly`]
          : []),
        ...labelArgs(object(state.volume?.Labels)),
        "--entrypoint",
        "/bin/sh",
        request.image,
        "-c",
        "exec sleep infinity",
      ];
      const mountShared = await ensureShared();
      let result = await run(createArgs(mountShared));
      state = await owned(request);
      if (!state.container && mountShared && result.exitCode !== 0) {
        // An engine that cannot bind the host cache (confinement, remote engine) launches without it.
        result = await run(createArgs(false));
        state = await owned(request);
      }
      if (!state.container) fail(result.exitCode === 0 ? "ownership_mismatch" : "docker_failed");
    }
    if (state.expiresAt === undefined || state.expiresAt <= now()) fail("expired");
    // Duplicate create can start an interrupted create, but never resume a stopped machine.
    const status = object(state.container.State);
    if (status.Running !== true) {
      if (status.Status !== "created") fail("ownership_mismatch");
      await checked([
        "container",
        "update",
        ...dockerResourceArgs(dockerHostResources(), options.limits?.()),
        state.containerName,
      ]);
      await ensureShared();
      await checked(["container", "start", state.containerName]);
    }
    return { containerName: state.containerName, volumeName: state.volumeName, expiresAt: state.expiresAt };
  }

  async function resume(request: DockerMachineRequest): Promise<void> {
    const state = await owned(request);
    if (!state.container || !state.volume) fail("not_found");
    if (state.expiresAt === undefined || state.expiresAt <= now()) fail("expired");
    const status = object(state.container.State);
    // Only the retained, ownership-verified allocation may resume; never recreate it.
    if (status.Running !== true) {
      if (status.Status !== "exited") fail("ownership_mismatch");
      await checked([
        "container",
        "update",
        ...dockerResourceArgs(dockerHostResources(), options.limits?.()),
        state.containerName,
      ]);
      // A retained container with the cache bind cannot start if its source vanished.
      await ensureShared();
      await checked(["container", "start", state.containerName]);
    }
  }

  async function bootstrap(
    request: DockerMachineRequest,
    input: { command: readonly string[]; stdin: string },
  ): Promise<void> {
    if (
      input.command.length === 0 ||
      !input.command[0]?.startsWith("/") ||
      input.command.some((arg) => arg.includes("\0"))
    )
      fail("invalid_request");
    const state = await owned(request);
    if (!state.container || object(state.container.State).Running !== true) fail("not_found");
    if (state.expiresAt === undefined || state.expiresAt <= now()) fail("expired");
    // Trusted fixed host command/arguments only, never forwarded remote exec flags or secrets.
    await checked(
      ["container", "exec", "--interactive", "--user", "1000:1000", state.containerName, ...input.command],
      input.stdin,
    );
  }

  async function installRuntime(request: DockerMachineRequest, executable: Uint8Array): Promise<void> {
    if (!(executable instanceof Uint8Array) || executable.byteLength < 1 || executable.byteLength > 512 * 1024 * 1024)
      fail("invalid_request");
    const state = await owned(request);
    if (!state.container || object(state.container.State).Running !== true) fail("not_found");
    if (state.expiresAt === undefined || state.expiresAt <= now()) fail("expired");
    // Archive ownership initializes the named-volume root without privileged guest execution.
    // Only caller-verified public executable bytes belong here, never credentials.
    const archive = runtimeArchive(executable);
    if (state.expiresAt <= now()) fail("expired");
    await checked(["cp", "--archive", "-", `${state.containerName}:/home`], archive);
  }

  async function stop(request: DockerMachineRequest): Promise<void> {
    const state = await owned(request);
    if (state.container) await checked(["container", "stop", "--time", "10", state.containerName]);
  }

  async function remove(
    request: DockerMachineRequest,
    target: { scope: "physical-only"; machineId: string } | { scope: "physical-and-retained" } = {
      scope: "physical-and-retained",
    },
  ): Promise<void> {
    const physicalOnly = target.scope === "physical-only";
    if (physicalOnly && !dockerContainerId.test(target.machineId)) fail("invalid_request");
    let state = await owned(request);
    if (state.container) {
      if (physicalOnly && state.container.Id !== target.machineId) fail("ownership_mismatch");
      await checked(["container", "rm", "--force", physicalOnly ? target.machineId : state.containerName]);
      state = await owned(request);
      if (state.container) fail("docker_failed");
    }
    if (physicalOnly) {
      const ids = (await checked(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"]))
        .trim()
        .split("\n")
        .filter(Boolean);
      if (ids.some((id) => !dockerContainerId.test(id)) || ids.includes(target.machineId)) fail("ownership_mismatch");
      return;
    }
    // Successful exact absence observation is required before deleting the exact owned volume.
    if (state.volume) await checked(["volume", "rm", state.volumeName]);
  }

  async function stopIfExpired(request: DockerMachineRequest): Promise<boolean> {
    const state = await owned(request);
    if (state.expiresAt === undefined || state.expiresAt > now()) return false;
    // A successful inventory proving no container also proves physical execution ended.
    if (!state.container) return true;
    await checked(["container", "stop", "--time", "10", state.containerName]);
    return true;
  }

  return {
    resume,
    create,
    bootstrap,
    installRuntime,
    stop,
    delete: remove,
    stopIfExpired,
    async readExpiredOutputs(request: DockerMachineRequest) {
      const state = await owned(request);
      if (!state.container && !state.volume) return null;
      if (state.expiresAt === undefined || state.expiresAt > now()) fail("expired");
      if (!state.container || object(state.container.State).Running !== false || !options.readArchive)
        fail("ownership_mismatch");
      // Inherit the exact inspected allocation’s mounts read-only. If cleanup already
      // removed it, Docker refuses; a missing named volume is never recreated.
      const containerId = state.container.Id;
      if (typeof containerId !== "string" || !/^[a-f0-9]{64}$/.test(containerId)) fail("ownership_mismatch");
      const archive = await options.readArchive([
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--workdir",
        "/",
        "--memory",
        "128m",
        "--pids-limit",
        "32",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "1000:1000",
        "--volumes-from",
        `${containerId}:ro`,
        "--entrypoint",
        "/usr/bin/timeout",
        officialSandboxImage(),
        "--kill-after=2s",
        "12s",
        "/usr/bin/python3",
        "-I",
        "-S",
        "-c",
        DOCKER_OUTPUT_ARCHIVE,
      ]);
      const current = await owned(request);
      if (current.container?.Id !== containerId || object(current.container.State).Running !== false)
        fail("ownership_mismatch");
      return archive;
    },
    async deleteStopped(request: DockerMachineRequest): Promise<void> {
      const state = await owned(request);
      if (state.container && object(state.container.State).Running !== false) fail("ownership_mismatch");
      await remove(request);
    },
    async isRunning(request: DockerMachineRequest): Promise<boolean> {
      const state = await owned(request);
      return !!state.container && object(state.container.State).Running === true;
    },
    async isAbsent(request: DockerMachineRequest): Promise<boolean> {
      const state = await owned(request);
      return !state.container && !state.volume;
    },
    async stoppedAt(request: DockerMachineRequest): Promise<number | null> {
      const state = await owned(request);
      const finished = state.container ? Date.parse(String(object(state.container.State).FinishedAt)) : NaN;
      return Number.isFinite(finished) && finished > 0 ? finished : null;
    },
    async isStopped(request: DockerMachineRequest): Promise<boolean> {
      const state = await owned(request);
      return !!state.volume && (!state.container || object(state.container.State).Running === false);
    },
    async buildSnapshot(job: Extract<DockerHostJob, { operation: "buildSnapshot" }>, recoverOnly = false) {
      context(job.request);
      await approveLocalImage(job.request.image);
      return buildDockerSnapshot(options, job, recoverOnly);
    },
  };
}

function labelArgs(labels: Row): string[] {
  return Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${String(value)}`]);
}

/** Fixed USTAR members only: no caller-controlled paths, owners, metadata or links. */
function runtimeArchive(executable: Uint8Array): Uint8Array {
  const block = 512;
  const archive = new Uint8Array(4 * block + Math.ceil(executable.byteLength / block) * block);
  const encoder = new TextEncoder();
  function header(offset: number, name: string, size: number, type: "0" | "5") {
    const bytes = archive.subarray(offset, offset + block);
    const text = (start: number, value: string) => bytes.set(encoder.encode(value), start);
    const octal = (start: number, width: number, value: number) =>
      text(start, `${value.toString(8).padStart(width - 1, "0")}\0`);
    text(0, name);
    octal(100, 8, 0o700);
    octal(108, 8, 1000);
    octal(116, 8, 1000);
    octal(124, 12, size);
    octal(136, 12, 0);
    bytes.fill(32, 148, 156);
    text(156, type);
    text(257, "ustar\0");
    text(263, "00");
    const checksum = bytes.reduce((sum, byte) => sum + byte, 0);
    text(148, `${checksum.toString(8).padStart(6, "0")}\0 `);
  }
  header(0, "user/", 0, "5");
  header(block, "user/armada-runtime", executable.byteLength, "0");
  archive.set(executable, 2 * block);
  return archive;
}
