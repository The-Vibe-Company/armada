import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ArmadaPlugin,
  LaunchRequest,
  NodeProvider,
  PluginContext,
  PrepareRequest,
  WorkerObservation,
  WorkerRef,
  Workspace,
} from "@armada/plugin-api";
import { WorkerRuntimeGone } from "@armada/plugin-api";
import { checkedMutation } from "@armada/plugin-api/guard";

import { supervisorScript } from "./supervisor.ts";
import { testMerge } from "./test-merge.ts";

const execute = promisify(execFileCallback);
const DEFAULT_OUTPUT_TAIL = 64 * 1024;
const DEFAULT_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_KILL_TIMEOUT_MS = 1_000;
const MAX_OUTPUT_TAIL = 1024 * 1024;
const MAX_SUPERVISOR_RESPONSE_BYTES = MAX_OUTPUT_TAIL * 6 + 1024 * 1024;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;
const BASE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
]);
const WINDOWS_ENV_KEYS = new Set([
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMSPEC",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "WINDIR",
  "USERPROFILE",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PROCESSOR_ARCHITEW6432",
  "NUMBER_OF_PROCESSORS",
]);

type LocalTransport = "auto" | "pipe" | "pty";

export interface LocalNodeOptions {
  /** Workspace directories are created below this path. */
  workspaceRoot?: string;
  /** A registered project's chosen checkout wins over the request's repository URL. */
  projects?: Record<string, { root: string }>;
  /** `auto` uses a PTY only when this process has a usable terminal. */
  transport?: LocalTransport;
  /** Maximum number of UTF-16 code units retained for each worker transcript. */
  outputTail?: number;
  /** Grace period after SIGTERM before SIGKILL. */
  stopTimeoutMs?: number;
  /** Grace period after SIGKILL before stop reports that the process is stuck. */
  killTimeoutMs?: number;
}

interface NormalizedOptions {
  workspaceRoot: string;
  projects: ReadonlyMap<string, string>;
  transport: LocalTransport;
  outputTail: number;
  stopTimeoutMs: number;
  killTimeoutMs: number;
}

interface WorkspaceRecord {
  readonly workspace: Workspace;
  readonly workspaceRoot: string;
  readonly repository: string;
  readonly branch: string;
  readonly base: string;
  lock: Promise<void>;
  removed: boolean;
}

interface WorkerRecord {
  readonly ref: WorkerRef;
  readonly workspace: WorkspaceRecord;
  readonly paths: SupervisorPaths;
  state: WorkerObservation["state"];
  output: string;
  deliveries: number;
  closedValue: boolean;
  stopPromise?: Promise<void>;
}

interface SupervisorPaths {
  directory: string;
  socket: string;
  state: string;
  /** The liveness contract the supervisor writes once the CLI runs in its pinned group. */
  pin: string;
}

interface SupervisorSnapshot {
  observation: WorkerObservation;
  deliveries: number;
  closed: boolean;
  workspace: Workspace;
  provenance: { repository: string; branch: string; base: string };
}

interface FinalSupervisorMetadata extends SupervisorSnapshot {
  version: 1;
  worker: WorkerRef;
  observation: { state: "stopped" | "failed" };
  closed: true;
}

function appDataWorkspaceRoot(): string {
  const configured = process.env.XDG_DATA_HOME?.trim();
  if (configured) return join(configured, "armada", "workspaces");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Armada", "workspaces");
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"), "Armada", "workspaces");
  return join(homedir(), ".local", "share", "armada", "workspaces");
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function normalizeOptions(options: LocalNodeOptions): NormalizedOptions {
  const transport = options.transport ?? "auto";
  if (transport !== "auto" && transport !== "pipe" && transport !== "pty")
    throw new Error(`unsupported local node transport ${String(transport)}`);
  const workspaceRoot = resolve(options.workspaceRoot?.trim() || appDataWorkspaceRoot());
  return {
    workspaceRoot,
    projects: new Map(
      Object.entries(options.projects ?? {}).map(([project, config]) => {
        if (!config.root?.trim()) throw new Error(`local project ${project} root must be a nonempty path`);
        return [project, resolve(config.root)];
      }),
    ),
    transport,
    outputTail: Math.min(positiveInteger(options.outputTail, DEFAULT_OUTPUT_TAIL, "outputTail"), MAX_OUTPUT_TAIL),
    stopTimeoutMs: positiveInteger(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, "stopTimeoutMs"),
    killTimeoutMs: positiveInteger(options.killTimeoutMs, DEFAULT_KILL_TIMEOUT_MS, "killTimeoutMs"),
  };
}

function workerEnvironment(explicit: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const uppercase = key.toUpperCase();
    if (
      BASE_ENV_KEYS.has(uppercase) ||
      (process.platform === "win32" && WINDOWS_ENV_KEYS.has(uppercase)) ||
      uppercase.startsWith("LC_")
    )
      environment[key] = value;
  }
  for (const [key, value] of Object.entries(explicit)) environment[key] = value;
  return environment;
}

function safePart(value: string, fallback: string): string {
  const part = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+$/, "");
  return part || fallback;
}

function inside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function sameWorker(a: WorkerRef, b: WorkerRef): boolean {
  return (
    a.project === b.project &&
    a.ticket === b.ticket &&
    a.session === b.session &&
    a.generation === b.generation &&
    a.handle === b.handle
  );
}

function sameWorkspace(a: Workspace, b: Workspace): boolean {
  return Boolean(a && b && a.id === b.id && a.path === b.path && a.node === b.node);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateWorkerRef(worker: WorkerRef): void {
  if (
    !worker.project.trim() ||
    !worker.ticket.trim() ||
    !worker.session.trim() ||
    !Number.isInteger(worker.generation) ||
    worker.generation < 1 ||
    !isUuid(worker.handle)
  )
    throw staleWorker();
}

function supervisorPaths(workspaceRoot: string, handle: string): SupervisorPaths {
  const digest = createHash("sha256").update(workspaceRoot).update("\0").update(handle).digest("hex").slice(0, 24);
  const directory = join(process.platform === "win32" ? tmpdir() : "/tmp", `armada-nl-${digest}`);
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\armada-nl-${digest}` : join(directory, "s");
  return { directory, socket, state: join(directory, "state.json"), pin: join(directory, "pin.json") };
}

async function privateDirectory(directory: string): Promise<boolean> {
  try {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) return false;
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && details.uid !== process.getuid()) return false;
      if ((details.mode & 0o077) !== 0) return false;
    }
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const details = await lstat(directory);
  if (
    !details.isDirectory() ||
    details.isSymbolicLink() ||
    (typeof process.getuid === "function" && details.uid !== process.getuid()) ||
    (process.platform !== "win32" && (details.mode & 0o077) !== 0)
  )
    throw new Error("local supervisor directory is not private");
}

function requestSupervisor(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error("local supervisor request timed out"));
    }, timeoutMs);
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else if (value) resolvePromise(value);
      else rejectPromise(new Error("local supervisor closed without a response"));
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_SUPERVISOR_RESPONSE_BYTES) {
        socket.destroy();
        finish(new Error("local supervisor response is too large"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(response.slice(0, newline)) as Record<string, unknown>;
      } catch {
        finish(new Error("invalid local supervisor response"));
        return;
      }
      if (typeof parsed.error === "string") finish(new Error(parsed.error));
      else if (parsed.ok === true) finish(undefined, parsed);
      else finish(new Error("invalid local supervisor response"));
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled)
        finish(Object.assign(new Error("local supervisor closed without a response"), { code: "ECONNRESET" }));
    });
  });
}

async function requestSupervisorWhenStarting(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs: number,
  privateDirectoryPath?: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      if (privateDirectoryPath) await assertPrivateDirectory(privateDirectoryPath);
      return await requestSupervisor(socketPath, request, Math.max(1, deadline - Date.now()));
    } catch (error) {
      if ((!isErrno(error, "ENOENT") && !isErrno(error, "ECONNREFUSED")) || Date.now() >= deadline) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(10, deadline - Date.now())));
    }
  }
}

function validObservation(value: unknown): value is WorkerObservation {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    ["starting", "running", "stopped", "failed", "unknown"].includes(String((value as WorkerObservation).state)) &&
    (!(value as WorkerObservation).reply || typeof (value as WorkerObservation).reply === "string")
  );
}

async function readFinalMetadata(
  paths: SupervisorPaths,
  worker: WorkerRef,
  workspace: Workspace,
): Promise<FinalSupervisorMetadata | undefined> {
  if (!(await privateDirectory(paths.directory))) return undefined;
  let text: string;
  try {
    const details = await lstat(paths.state);
    if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_SUPERVISOR_RESPONSE_BYTES)
      throw new Error("invalid local supervisor metadata");
    text = await readFile(paths.state, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  let metadata: FinalSupervisorMetadata;
  try {
    metadata = JSON.parse(text) as FinalSupervisorMetadata;
  } catch {
    throw new Error("invalid local supervisor metadata");
  }
  if (
    metadata.version !== 1 ||
    !sameWorker(metadata.worker, worker) ||
    !sameWorkspace(metadata.workspace, workspace) ||
    !validObservation(metadata.observation) ||
    (metadata.observation.state !== "stopped" && metadata.observation.state !== "failed") ||
    metadata.closed !== true ||
    !Number.isInteger(metadata.deliveries) ||
    metadata.deliveries < 0 ||
    !metadata.provenance ||
    typeof metadata.provenance.repository !== "string" ||
    typeof metadata.provenance.branch !== "string" ||
    typeof metadata.provenance.base !== "string"
  )
    throw staleWorker();
  return metadata;
}

async function removeFinalMetadata(paths: SupervisorPaths): Promise<void> {
  await unlink(paths.state).catch(() => {});
  await unlink(paths.pin).catch(() => {});
  await rmdir(paths.directory).catch(() => {});
}

interface LivenessContract {
  version: 1;
  worker: WorkerRef;
  workspace: Workspace;
  /** The pinned process group's id: the pin runner's pid, a group leader until the whole group ends. */
  group: number;
  platform: string;
  establishedAt: string;
}

/** The contract the supervisor wrote once the CLI ran; absent for workers launched before it existed. */
async function readLivenessContract(
  paths: SupervisorPaths,
  worker: WorkerRef,
  workspace: Workspace,
): Promise<{ kind: "none" } | { kind: "invalid"; reason: string } | { kind: "contract"; contract: LivenessContract }> {
  if (!(await privateDirectory(paths.directory))) return { kind: "none" };
  let text: string;
  try {
    const details = await lstat(paths.pin);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 64 * 1024)
      return { kind: "invalid", reason: "its liveness contract is not a private file" };
    text = await readFile(paths.pin, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "none" };
    return { kind: "invalid", reason: "its liveness contract could not be read" };
  }
  let contract: LivenessContract;
  try {
    contract = JSON.parse(text) as LivenessContract;
  } catch {
    return { kind: "invalid", reason: "its liveness contract is not valid JSON" };
  }
  if (!contract || contract.version !== 1)
    return { kind: "invalid", reason: "its liveness contract has an unknown version" };
  if (!sameWorker(contract.worker, worker) || !sameWorkspace(contract.workspace, workspace))
    return { kind: "invalid", reason: "its liveness contract belongs to another worker generation" };
  if (!Number.isInteger(contract.group) || contract.group < 2 || contract.platform !== process.platform)
    return { kind: "invalid", reason: "its liveness contract names no process group of this platform" };
  return { kind: "contract", contract };
}

/**
 * The supervisor endpoint is unreachable and left no final record. Only the version 1 liveness
 * contract plus the end of its recorded process group proves the tree ended; `kill(-group, 0)`
 * delivers nothing and the kernel keeps a group id reserved while any member lives, so it can
 * say "gone" only when every member exited. Everything else stays unknown or still running.
 */
async function unreachableWorker(
  paths: SupervisorPaths,
  worker: WorkerRef,
  workspace: Workspace,
  error: unknown,
): Promise<Error> {
  const finding = isErrno(error, "ENOENT")
    ? `no supervisor endpoint at ${paths.socket}`
    : `the supervisor endpoint ${paths.socket} refused the connection`;
  const head = `local worker ${worker.ticket} generation ${worker.generation} is unreachable: ${finding}, and no final record exists`;
  const read = await readLivenessContract(paths, worker, workspace);
  if (read.kind === "none")
    return new Error(
      `${head}; no liveness contract was recorded for it (launched before version 1 or ended before its CLI started), so its process tree may still run; nothing was signaled`,
    );
  if (read.kind === "invalid")
    return new Error(`${head}; ${read.reason}, so its process tree may still run; nothing was signaled`);
  if (process.platform === "win32")
    return new Error(`${head}; process-group liveness cannot be checked on Windows, so its tree may still run`);
  try {
    process.kill(-read.contract.group, 0);
    return new Error(
      `${head}; its process group still exists, so the worker's CLI or a descendant still runs; nothing was signaled`,
    );
  } catch (probe) {
    if (isErrno(probe, "ESRCH"))
      return new WorkerRuntimeGone(
        `${head}; its liveness contract (version 1) names a process group that no longer exists, so its whole process tree ended; nothing was signaled`,
      );
    return new Error(
      `${head}; its process group could not be inspected (${isErrno(probe, "EPERM") ? "EPERM" : "unknown error"}), so its tree may still run; nothing was signaled`,
    );
  }
}

function staleWorker(): Error {
  return new Error("worker reference is stale or mismatched; left the worker untouched");
}

function invalidInput(message: string): Error {
  return new Error(`invalid local node request: ${message}`);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function isExitCode(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function git(
  args: readonly string[],
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await execute("git", [...args], {
    cwd: options.cwd,
    signal: options.signal,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
  return { stdout: textOf(result.stdout), stderr: textOf(result.stderr) };
}

// Linked checkouts share Git's info/exclude. Serialize its append across local
// providers so parallel project launches cannot duplicate or overwrite rules.
const excludeWrites = new Map<string, Promise<void>>();
// One admission at a time per kept worktree path, so two launches cannot both reuse it.
const reuseAdmissions = new Map<string, Promise<Workspace | undefined>>();

async function projectWorktreeRoot(projectRoot: string, path: string, signal?: AbortSignal): Promise<void> {
  for (const directory of [join(projectRoot, ".armada"), join(projectRoot, ".armada", "worktrees")]) {
    signal?.throwIfAborted();
    // Create one level at a time: recursive mkdir follows pre-existing symlinks.
    try {
      await mkdir(directory);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const entry = await lstat(directory);
    if (entry.isSymbolicLink()) throw invalidInput("project worktree parents must not be symbolic links");
    if (!entry.isDirectory()) throw invalidInput("project worktree parents must be directories");
  }
  try {
    if ((await lstat(path)).isSymbolicLink()) throw invalidInput("project worktree must not be a symbolic link");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

// The real path of `path`, or of its nearest existing ancestor joined with the rest,
// so a root reached through a symlink (macOS's /var → /private/var) compares with
// Git's own toplevel, which is always real.
async function realPathOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT") || dirname(path) === path) throw error;
    return join(await realPathOf(dirname(path)), basename(path));
  }
}

async function excludeWorktrees(source: string, workspaceRoot: string, signal?: AbortSignal): Promise<void> {
  const exclude = resolve(
    source,
    (await git(["rev-parse", "--git-path", "info/exclude"], { cwd: source, signal })).stdout.trim(),
  );
  const pattern = `/${relative(await realPathOf(source), await realPathOf(workspaceRoot))
    .replaceAll("\\", "/")
    .replace(/[[\]*?]/g, "\\$&")}/`;
  const previous = excludeWrites.get(exclude) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      signal?.throwIfAborted();
      let body = "";
      try {
        body = await readFile(exclude, "utf8");
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
      if (body.split(/\r?\n/).includes(pattern)) return;
      await mkdir(dirname(exclude), { recursive: true });
      signal?.throwIfAborted();
      await appendFile(exclude, `${body && !body.endsWith("\n") ? "\n" : ""}${pattern}\n`);
    });
  excludeWrites.set(exclude, operation);
  try {
    await operation;
  } finally {
    if (excludeWrites.get(exclude) === operation) excludeWrites.delete(exclude);
  }
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execute("which", [command], { encoding: "utf8", maxBuffer: 16 * 1024 });
    return true;
  } catch {
    return false;
  }
}

/**
 * A local node is deliberately process based. The host's guarded() scope is
 * required for every operation that can write to a worker or process.
 */
export class LocalNode implements NodeProvider {
  readonly #options: NormalizedOptions;
  readonly #workspaces = new Map<string, WorkspaceRecord>();
  readonly #workers = new Map<string, WorkerRecord>();
  #ptyAvailable: Promise<boolean> | undefined;

  constructor(options: LocalNodeOptions = {}) {
    this.#options = normalizeOptions(options);
  }

  async prepare(request: PrepareRequest): Promise<Workspace> {
    if (!request.project.trim()) throw invalidInput("project is empty");
    if (!request.ticket.trim()) throw invalidInput("ticket is empty");
    if (!request.repository.trim()) throw invalidInput("repository is empty");
    if (!request.branch.trim()) throw invalidInput("branch is empty");
    if (request.branch.includes("\0")) throw invalidInput("branch contains NUL");

    const projectRoot = this.#options.projects.get(request.project);
    const workspaceRoot = projectRoot ? join(projectRoot, ".armada", "worktrees") : this.#options.workspaceRoot;
    const repository = projectRoot ?? resolve(request.repository);
    const source = textOf(
      (await git(["rev-parse", "--show-toplevel"], { cwd: repository, signal: request.signal })).stdout,
    ).trim();
    if (!source) throw new Error("local node could not resolve the repository root");
    await git(["check-ref-format", "--branch", request.branch], {
      cwd: source,
      signal: request.signal,
    });

    const id = randomUUID();
    const path = join(
      workspaceRoot,
      projectRoot
        ? safePart(request.ticket, "ticket")
        : `${safePart(request.project, "project")}-${safePart(request.ticket, "ticket")}-${id}`,
    );
    if (projectRoot) {
      await projectWorktreeRoot(projectRoot, path, request.signal);
      await excludeWorktrees(source, workspaceRoot, request.signal);
      const kept = await this.#keptWorktree(source, path, workspaceRoot, request);
      if (kept) return kept;
    } else await mkdir(workspaceRoot, { recursive: true });

    const base = (await git(["rev-parse", "HEAD"], { cwd: source, signal: request.signal })).stdout.trim();
    let worktreeAdded = false;
    try {
      let exists = false;
      try {
        await git(["show-ref", "--verify", "--quiet", `refs/heads/${request.branch}`], {
          cwd: source,
          signal: request.signal,
        });
        exists = true;
      } catch (error) {
        if (!isExitCode(error, 1)) throw error;
      }
      const worktreeArgs = ["worktree", "add", "--quiet"];
      if (exists) worktreeArgs.push(path, request.branch);
      else worktreeArgs.push("-b", request.branch, path, "HEAD");
      await git(worktreeArgs, { cwd: source, signal: request.signal });
      worktreeAdded = true;
      const current = (await git(["branch", "--show-current"], { cwd: path, signal: request.signal })).stdout.trim();
      if (current !== request.branch) {
        throw new Error(`local node checked out ${current || "(detached HEAD)"}, expected ${request.branch}`);
      }
      const workspace: Workspace = { id, path, node: "local" };
      this.#workspaces.set(id, {
        workspace: { ...workspace },
        workspaceRoot,
        repository: source,
        branch: request.branch,
        base,
        lock: Promise.resolve(),
        removed: false,
      });
      return workspace;
    } catch (error) {
      if (worktreeAdded) await this.#removeWorktree(source, path).catch(() => {});
      throw error;
    }
  }

  async launch(request: LaunchRequest): Promise<WorkerRef> {
    const workspace = this.#workspace(request.workspace);
    if (!request.worker.project.trim()) throw invalidInput("worker project is empty");
    if (!request.worker.ticket.trim()) throw invalidInput("worker ticket is empty");
    if (!request.worker.session.trim()) throw invalidInput("worker session is empty");
    if (!Number.isInteger(request.worker.generation) || request.worker.generation < 1)
      throw invalidInput("worker generation must be a positive integer");
    const handle = request.handle ?? randomUUID();
    if (!isUuid(handle)) throw invalidInput("worker handle must be a UUID");
    if (!request.command || request.command.includes("\0")) throw invalidInput("command is empty or contains NUL");
    if (request.args.some((arg) => arg.includes("\0"))) throw invalidInput("argument contains NUL");

    return withWorkspaceLock(workspace, async () => {
      if (workspace.removed) throw new Error("workspace has already been disposed");
      if (this.#activeWorker(workspace)) throw new Error("workspace already has an active worker");
      const ref: WorkerRef = { ...request.worker, handle };
      if (this.#workers.has(ref.handle)) throw new Error("worker handle is already owned by this local node");
      const usePty = await this.#usePty();
      const spec = this.#spawnSpec(request, usePty);
      const paths = supervisorPaths(workspace.workspaceRoot, ref.handle);
      const record = this.#record(ref, workspace, paths);
      const config = {
        paths,
        worker: ref,
        workspace: workspace.workspace,
        provenance: { repository: workspace.repository, branch: workspace.branch, base: workspace.base },
        command: spec.command,
        args: spec.args,
        env: workerEnvironment(request.env),
        outputTail: this.#options.outputTail,
        stopTimeoutMs: this.#options.stopTimeoutMs,
        killTimeoutMs: this.#options.killTimeoutMs,
      };
      await checkedMutation(request.worker, () => {
        this.#workers.set(ref.handle, record);
        this.#spawnSupervisor(config, workspace.workspaceRoot);
        return undefined;
      });
      try {
        const response = await requestSupervisorWhenStarting(
          paths.socket,
          { op: "launch", worker: ref, workspace: workspace.workspace },
          this.#startupTimeout(),
        );
        this.#applySnapshot(record, response);
      } catch (error) {
        await this.#requestFinalSnapshot(record).catch(() => {});
        throw error;
      }
      return ref;
    });
  }

  async adopt(
    worker: WorkerRef,
    workspace: Workspace,
    recovery: { starting?: boolean } = {},
  ): Promise<{ deliveries: number }> {
    validateWorkerRef(worker);
    const workspaceRoot = this.#workspaceRoot(worker.project);
    this.#validateWorkspace(workspace, worker.project);
    const paths = supervisorPaths(workspaceRoot, worker.handle);
    const existing = this.#workers.get(worker.handle);
    if (existing) {
      if (
        existing.workspace.removed ||
        existing.workspace.workspaceRoot !== workspaceRoot ||
        !sameWorker(existing.ref, worker) ||
        !sameWorkspace(existing.workspace.workspace, workspace)
      )
        throw staleWorker();
      if (existing.closedValue) return { deliveries: existing.deliveries };
      if (recovery.starting) {
        try {
          const response = await requestSupervisorWhenStarting(
            existing.paths.socket,
            { op: "adopt", worker, workspace },
            this.#startupTimeout(),
            existing.paths.directory,
          );
          this.#applySnapshot(existing, response);
        } catch (error) {
          if (!supervisorUnavailable(error)) throw error;
          const final = await readFinalMetadata(existing.paths, worker, workspace);
          if (!final) throw error;
          this.#applySnapshot(existing, final);
        }
      } else {
        try {
          await this.#refresh(existing, "adopt");
        } catch (error) {
          if (!supervisorUnavailable(error)) throw error;
          const final = await readFinalMetadata(existing.paths, worker, workspace);
          if (final) this.#applySnapshot(existing, final);
          else {
            const verdict = await unreachableWorker(existing.paths, worker, workspace, error);
            if (verdict instanceof WorkerRuntimeGone) {
              // The group ended: this record no longer holds its workspace.
              existing.state = "failed";
              existing.closedValue = true;
            } else existing.state = "unknown";
            throw verdict;
          }
        }
      }
      return { deliveries: existing.deliveries };
    }

    let snapshot: SupervisorSnapshot | FinalSupervisorMetadata;
    try {
      let response: Record<string, unknown>;
      if (recovery.starting) {
        response = await requestSupervisorWhenStarting(
          paths.socket,
          { op: "adopt", worker, workspace },
          this.#startupTimeout(),
          paths.directory,
        );
      } else {
        if (!(await privateDirectory(paths.directory)))
          throw Object.assign(new Error("local supervisor is unavailable"), { code: "ENOENT" });
        response = await requestSupervisor(paths.socket, { op: "adopt", worker, workspace });
      }
      snapshot = this.#readSnapshot(response, worker, workspace);
    } catch (error) {
      if (!supervisorUnavailable(error)) throw error;
      const final = await readFinalMetadata(paths, worker, workspace);
      // A launch that never returned its handle stays a raw transport error: unknown, never gone.
      if (!final) throw recovery.starting ? error : await unreachableWorker(paths, worker, workspace, error);
      snapshot = final;
    }

    const workspaceRecord = this.#workspaceFromMetadata(workspace, snapshot.provenance, worker.project);
    const record = this.#record(worker, workspaceRecord, paths);
    this.#applySnapshot(record, snapshot);
    this.#workers.set(worker.handle, record);
    return { deliveries: record.deliveries };
  }

  async deliver(worker: WorkerRef, message: string, deliveryKey: string): Promise<void> {
    if (!deliveryKey) throw invalidInput("delivery key is empty");
    const record = this.#worker(worker);
    return withWorkspaceLock(record.workspace, async () => {
      const current = this.#worker(worker);
      if (current !== record) throw staleWorker();
      await checkedMutation(worker, async () => {
        if (this.#worker(worker) !== record) throw staleWorker();
        if (record.closedValue || record.state !== "running") throw new Error("worker is no longer running");
        const response = await this.#request(record, "deliver", { message, deliveryKey });
        this.#applySnapshot(record, response);
      });
    });
  }

  async transcript(worker: WorkerRef, maxBytes: number): Promise<string> {
    const record = this.#worker(worker);
    const bytes = Buffer.from(record.output);
    let start = Math.max(0, bytes.length - Math.max(0, Math.min(4096, maxBytes)));
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString("utf8");
  }

  async observe(worker: WorkerRef): Promise<WorkerObservation> {
    const record = this.#worker(worker);
    // A completed stop already proves group termination. The endpoint can disappear
    // while its last response drains; no further transport read is needed.
    if (record.closedValue) return { state: record.state, reply: record.output, acceptedDeliveries: record.deliveries };
    try {
      await this.#refresh(record, "observe");
    } catch (error) {
      if (!supervisorUnavailable(error)) throw error;
      const final = await readFinalMetadata(record.paths, worker, record.workspace.workspace);
      if (final) this.#applySnapshot(record, final);
      else if (!record.closedValue) record.state = "unknown";
    }
    return { state: record.state, reply: record.output, acceptedDeliveries: record.deliveries };
  }

  async stop(worker: WorkerRef): Promise<void> {
    const record = this.#worker(worker);
    if (record.stopPromise) return record.stopPromise;
    let operation!: Promise<void>;
    operation = withWorkspaceLock(record.workspace, async () => {
      const current = this.#worker(worker);
      if (current !== record) throw staleWorker();
      if (current.closedValue) {
        await checkedMutation(worker, () => undefined);
        return;
      }
      await checkedMutation(worker, async () => {
        if (this.#worker(worker) !== current) throw staleWorker();
        try {
          const response = await this.#request(current, "stop", {}, this.#stopTimeout());
          this.#applySnapshot(current, response);
        } catch (error) {
          const final = await readFinalMetadata(current.paths, worker, current.workspace.workspace);
          if (!final) throw error;
          this.#applySnapshot(current, final);
        }
      });
    }).catch((error: unknown) => {
      if (record.stopPromise === operation) record.stopPromise = undefined;
      throw error;
    });
    record.stopPromise = operation;
    return operation;
  }

  async dispose(workspace: Workspace): Promise<void> {
    const record = this.#workspace(workspace);
    await withWorkspaceLock(record, async () => {
      if (record.removed) return;
      if (this.#activeWorker(record)) throw new Error("workspace has an active worker; kept it");
      const status = await git(["status", "--porcelain", "--untracked-files=all"], { cwd: record.workspace.path });
      if (status.stdout.trim()) throw new Error("workspace is dirty; kept it");
      // V1 runtime archival keeps clean work that has not been pushed, too.
      const unpushed = await git(["rev-list", "HEAD", "--not", record.base, "--remotes"], {
        cwd: record.workspace.path,
      });
      if (unpushed.stdout.trim()) throw new Error("workspace has unpushed commits; kept it");
      if (this.#activeWorker(record)) throw new Error("workspace gained an active worker; kept it");
      await this.#removeWorktree(record.repository, record.workspace.path);
      for (const workerRecord of this.#workers.values()) {
        if (workerRecord.workspace === record) await removeFinalMetadata(workerRecord.paths);
      }
      record.removed = true;
      this.#workspaces.delete(record.workspace.id);
    });
  }

  #workspace(workspace: Workspace): WorkspaceRecord {
    const record = this.#workspaces.get(workspace.id);
    if (
      !record ||
      record.workspace.node !== workspace.node ||
      record.workspace.path !== workspace.path ||
      !inside(record.workspaceRoot, workspace.path)
    )
      throw new Error("workspace is not owned by this local node");
    return record;
  }

  #validateWorkspace(workspace: Workspace, project: string): void {
    if (
      !workspace ||
      workspace.node !== "local" ||
      !isUuid(workspace.id) ||
      !workspace.path ||
      !inside(this.#workspaceRoot(project), resolve(workspace.path))
    )
      throw new Error("workspace is not owned by this local node");
  }

  #worker(worker: WorkerRef): WorkerRecord {
    const record = this.#workers.get(worker.handle);
    if (!record || !sameWorker(record.ref, worker)) throw staleWorker();
    return record;
  }

  /** By path: a reused worktree gets a new workspace record, and one worker per directory is the rule. */
  #activeWorker(workspace: WorkspaceRecord): WorkerRecord | undefined {
    for (const record of this.#workers.values())
      if (
        (record.workspace === workspace || record.workspace.workspace.path === workspace.workspace.path) &&
        !record.closedValue
      )
        return record;
    return undefined;
  }

  /**
   * A project worktree kept from an earlier generation (a released or lost worker) is reused
   * for the same branch instead of failing `git worktree add`: nothing in it is reset, so dirty
   * and unpushed work survives. Provenance is checked beyond the branch name: the source lists
   * the directory as its worktree, attached (not detached, not prunable) to that branch, and the
   * directory's own toplevel is itself. Admission is serialized per path and refused while a
   * worker of this node still runs there.
   */
  async #keptWorktree(
    source: string,
    path: string,
    workspaceRoot: string,
    request: PrepareRequest,
  ): Promise<Workspace | undefined> {
    const previous = reuseAdmissions.get(path) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async (): Promise<Workspace | undefined> => {
        try {
          if ((await lstat(path)).isSymbolicLink()) throw invalidInput("project worktree must not be a symbolic link");
        } catch (error) {
          if (isErrno(error, "ENOENT")) return undefined;
          throw error;
        }
        const real = await realPathOf(path);
        const describe = `${path} already exists`;
        const listing = (await git(["worktree", "list", "--porcelain"], { cwd: source, signal: request.signal }))
          .stdout;
        let entry: string[] | undefined;
        for (const block of listing.split(/\r?\n\r?\n/)) {
          const lines = block.split(/\r?\n/);
          const first = lines[0];
          if (!first?.startsWith("worktree ")) continue;
          if ((await realPathOf(first.slice("worktree ".length))) === real) {
            entry = lines;
            break;
          }
        }
        if (!entry)
          throw invalidInput(
            `${describe} but is not a worktree of ${source}; move it aside before launching ${request.ticket}`,
          );
        const branch = entry.find((line) => line.startsWith("branch "))?.slice("branch ".length);
        if (
          entry.includes("detached") ||
          entry.some((line) => line.startsWith("prunable")) ||
          branch !== `refs/heads/${request.branch}`
        )
          throw invalidInput(
            `${describe} as a kept worktree on ${branch ? branch.replace(/^refs\/heads\//, "") : "(detached HEAD)"}, not ${request.branch}; move it aside or finish it before launching ${request.ticket}`,
          );
        request.signal?.throwIfAborted();
        const current = (await git(["branch", "--show-current"], { cwd: path, signal: request.signal })).stdout.trim();
        const top = (await git(["rev-parse", "--show-toplevel"], { cwd: path, signal: request.signal })).stdout.trim();
        if (current !== request.branch || !top || (await realPathOf(top)) !== real)
          throw invalidInput(
            `${describe} but its checkout is not ${request.branch} at that path; inspect it before launching`,
          );
        const busy = [...this.#workers.values()].find(
          (record) => record.workspace.workspace.path === path && !record.closedValue,
        );
        if (busy) throw new Error("workspace already has an active worker");
        const base = (await git(["rev-parse", "HEAD"], { cwd: source, signal: request.signal })).stdout.trim();
        const workspace: Workspace = { id: randomUUID(), path, node: "local" };
        this.#workspaces.set(workspace.id, {
          workspace: { ...workspace },
          workspaceRoot,
          repository: source,
          branch: request.branch,
          base,
          lock: Promise.resolve(),
          removed: false,
        });
        return workspace;
      });
    reuseAdmissions.set(path, operation);
    try {
      return await operation;
    } finally {
      if (reuseAdmissions.get(path) === operation) reuseAdmissions.delete(path);
    }
  }

  #record(ref: WorkerRef, workspace: WorkspaceRecord, paths: SupervisorPaths): WorkerRecord {
    return {
      ref: { ...ref },
      workspace,
      paths,
      deliveries: 0,
      state: "starting",
      output: "",
      closedValue: false,
    };
  }

  #spawnSupervisor(config: Record<string, unknown>, workspaceRoot: string): void {
    const supervisorEnvironment = workerEnvironment({});
    if (process.versions.electron) supervisorEnvironment.ELECTRON_RUN_AS_NODE = "1";
    const supervisor = spawn(process.execPath, ["-e", supervisorScript], {
      cwd: workspaceRoot,
      detached: true,
      env: supervisorEnvironment,
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    supervisor.once("error", () => {});
    supervisor.unref();
    const input = supervisor.stdin;
    if (!input) throw new Error("local supervisor input is unavailable");
    input.on("error", () => {});
    input.end(`${JSON.stringify(config)}\n`);
  }

  async #refresh(record: WorkerRecord, operation: "adopt" | "observe"): Promise<void> {
    const response = await this.#request(record, operation);
    this.#applySnapshot(record, response);
  }

  async #request(
    record: WorkerRecord,
    operation: string,
    extra: Record<string, unknown> = {},
    timeoutMs = 5_000,
  ): Promise<Record<string, unknown>> {
    if (!(await privateDirectory(record.paths.directory)))
      throw Object.assign(new Error("local supervisor is unavailable"), { code: "ENOENT" });
    const response = await requestSupervisor(
      record.paths.socket,
      { op: operation, worker: record.ref, workspace: record.workspace.workspace, ...extra },
      timeoutMs,
    );
    this.#readSnapshot(response, record.ref, record.workspace.workspace);
    return response;
  }

  #readSnapshot(response: Record<string, unknown>, worker: WorkerRef, workspace: Workspace): SupervisorSnapshot {
    const snapshot = response as unknown as SupervisorSnapshot & { workspace?: Workspace; provenance?: unknown };
    const provenance = snapshot.provenance as Record<string, unknown> | undefined;
    if (
      !validObservation(snapshot.observation) ||
      !Number.isInteger(snapshot.deliveries) ||
      snapshot.deliveries < 0 ||
      typeof snapshot.closed !== "boolean" ||
      !sameWorkspace(snapshot.workspace, workspace) ||
      !provenance ||
      typeof provenance.repository !== "string" ||
      typeof provenance.branch !== "string" ||
      typeof provenance.base !== "string"
    )
      throw staleWorker();
    if (!worker.handle) throw staleWorker();
    return snapshot;
  }

  #applySnapshot(
    record: WorkerRecord,
    value: SupervisorSnapshot | FinalSupervisorMetadata | Record<string, unknown>,
  ): void {
    const snapshot = this.#readSnapshot(value as Record<string, unknown>, record.ref, record.workspace.workspace);
    record.state = snapshot.observation.state;
    record.output = snapshot.observation.reply ?? "";
    record.deliveries = snapshot.deliveries;
    record.closedValue = snapshot.closed;
  }

  async #requestFinalSnapshot(record: WorkerRecord): Promise<void> {
    const final = await readFinalMetadata(record.paths, record.ref, record.workspace.workspace);
    if (final) this.#applySnapshot(record, final);
  }

  #workspaceFromMetadata(
    workspace: Workspace,
    provenance: { repository: string; branch: string; base: string },
    project: string,
  ): WorkspaceRecord {
    this.#validateWorkspace(workspace, project);
    const workspaceRoot = this.#workspaceRoot(project);
    if (!provenance.repository || !isAbsolute(provenance.repository) || !provenance.branch || !provenance.base)
      throw new Error("local supervisor workspace provenance is invalid");
    const existing = this.#workspaces.get(workspace.id);
    if (existing) {
      if (
        !sameWorkspace(existing.workspace, workspace) ||
        existing.workspaceRoot !== workspaceRoot ||
        existing.repository !== provenance.repository ||
        existing.branch !== provenance.branch ||
        existing.base !== provenance.base
      )
        throw new Error("workspace provenance does not match the local node");
      return existing;
    }
    const record: WorkspaceRecord = {
      workspace: { ...workspace },
      workspaceRoot,
      repository: resolve(provenance.repository),
      branch: provenance.branch,
      base: provenance.base,
      lock: Promise.resolve(),
      removed: false,
    };
    this.#workspaces.set(workspace.id, record);
    return record;
  }

  #workspaceRoot(project: string): string {
    const projectRoot = this.#options.projects.get(project);
    return projectRoot ? join(projectRoot, ".armada", "worktrees") : this.#options.workspaceRoot;
  }

  #stopTimeout(): number {
    return Math.min(2_147_000_000, this.#options.stopTimeoutMs + this.#options.killTimeoutMs + 10_000);
  }

  #startupTimeout(): number {
    return Math.max(5_000, Math.min(30_000, this.#options.stopTimeoutMs + this.#options.killTimeoutMs + 5_000));
  }

  async #removeWorktree(repository: string, path: string): Promise<void> {
    await git(["worktree", "remove", path], { cwd: repository });
  }

  async #usePty(): Promise<boolean> {
    if (this.#options.transport === "pipe") return false;
    if (process.platform === "win32") return false;
    if (!process.stdin.isTTY && !process.stdout.isTTY && !process.stderr.isTTY) return false;
    this.#ptyAvailable ??= commandAvailable("script");
    return (await this.#ptyAvailable) && (this.#options.transport === "pty" || this.#options.transport === "auto");
  }

  #spawnSpec(request: LaunchRequest, pty: boolean): { command: string; args: string[] } {
    if (!pty) return { command: request.command, args: [...request.args] };
    if (process.platform === "darwin")
      return { command: "script", args: ["-q", "/dev/null", request.command, ...request.args] };
    const line = commandLine(request.command, request.args);
    return { command: "script", args: ["-qefc", line, "/dev/null"] };
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function supervisorUnavailable(error: unknown): boolean {
  return (
    isErrno(error, "ENOENT") ||
    isErrno(error, "ECONNREFUSED") ||
    isErrno(error, "ECONNRESET") ||
    isErrno(error, "EPIPE")
  );
}

async function withWorkspaceLock<T>(workspace: WorkspaceRecord, action: () => Promise<T>): Promise<T> {
  const previous = workspace.lock;
  let release!: () => void;
  workspace.lock = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

export function createLocalNode(options: LocalNodeOptions = {}): NodeProvider {
  const node = new LocalNode(options);
  // Providers are often wrapped with object spread by hosts while installing
  // generation guards. Keep the public methods as own, bound properties.
  return {
    testMerge,
    prepare: node.prepare.bind(node),
    launch: node.launch.bind(node),
    adopt: node.adopt.bind(node),
    deliver: node.deliver.bind(node),
    observe: node.observe.bind(node),
    transcript: node.transcript.bind(node),
    stop: node.stop.bind(node),
    dispose: node.dispose.bind(node),
  };
}

export function activate(ctx: PluginContext): void {
  const options = (ctx.config.node?.local ?? {}) as LocalNodeOptions;
  ctx.register.node("local", createLocalNode(options));
}

export const plugin: ArmadaPlugin = { activate };
