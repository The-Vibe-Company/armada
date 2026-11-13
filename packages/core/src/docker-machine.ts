/** Direct argv execution only; adapters must never invoke a shell or log stdin/output. */
export interface DockerMachineCli {
  run(argv: readonly string[], stdin?: string | Uint8Array): Promise<{ exitCode: number; stdout: string }>;
}

export interface DockerMachineRequest {
  sandboxId: string;
  generation: string;
  /** Host-approved digest-pinned image, not a remote caller's arbitrary image. */
  image: string;
  ttlSeconds: number;
}

export class DockerMachineError extends Error {
  constructor(readonly code: "invalid_request" | "docker_failed" | "ownership_mismatch" | "expired" | "not_found") {
    super(`Docker machine ${code}`);
    this.name = "DockerMachineError";
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const imageDigest = /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/;
const prefix = "dev.armada.machine.";
type Row = Record<string, unknown>;

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
}) {
  if (!uuid.test(options.installationId) || !uuid.test(options.hostId)) fail("invalid_request");

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
      !imageDigest.test(request.image) ||
      !Number.isInteger(request.ttlSeconds) ||
      request.ttlSeconds < 1 ||
      request.ttlSeconds > 86_400
    )
      fail("invalid_request");
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
      end !== created + request.ttlSeconds * 1000
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
        mounts.length !== 1
      )
        fail("ownership_mismatch");
      const mount = object(mounts[0]);
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

  async function create(request: DockerMachineRequest) {
    let state = await owned(request);
    if (!state.volume) {
      const created = now();
      const labels = {
        ...state.labels,
        [`${prefix}created-at`]: String(created),
        [`${prefix}expires-at`]: String(created + request.ttlSeconds * 1000),
      };
      await checked(["volume", "create", "--driver", "local", ...labelArgs(labels), state.volumeName]);
      state = await owned(request);
      if (!state.volume) fail("docker_failed");
    }
    if (state.expiresAt === undefined) fail("ownership_mismatch");
    if (state.expiresAt <= now()) fail("expired");
    if (!state.container) {
      const result = await run([
        "container",
        "create",
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
        ...labelArgs(object(state.volume?.Labels)),
        "--entrypoint",
        "/bin/sh",
        request.image,
        "-c",
        "exec sleep infinity",
      ]);
      state = await owned(request);
      if (!state.container) fail(result.exitCode === 0 ? "ownership_mismatch" : "docker_failed");
    }
    if (state.expiresAt === undefined || state.expiresAt <= now()) fail("expired");
    // Duplicate create can start an interrupted create, but never resume a stopped machine.
    const status = object(state.container.State);
    if (status.Running !== true) {
      if (status.Status !== "created") fail("ownership_mismatch");
      await checked(["container", "start", state.containerName]);
    }
    return { containerName: state.containerName, volumeName: state.volumeName, expiresAt: state.expiresAt };
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

  async function remove(request: DockerMachineRequest): Promise<void> {
    let state = await owned(request);
    if (state.container) {
      await checked(["container", "rm", "--force", state.containerName]);
      state = await owned(request);
      if (state.container) fail("docker_failed");
    }
    // Successful exact absence observation is required before deleting the exact owned volume.
    if (state.volume) await checked(["volume", "rm", state.volumeName]);
  }

  async function stopIfExpired(request: DockerMachineRequest): Promise<boolean> {
    const state = await owned(request);
    if (!state.container || state.expiresAt === undefined || state.expiresAt > now()) return false;
    await checked(["container", "stop", "--time", "10", state.containerName]);
    return true;
  }

  return { create, bootstrap, installRuntime, stop, delete: remove, stopIfExpired };
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
