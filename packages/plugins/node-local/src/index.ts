import { type ChildProcessWithoutNullStreams, execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
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
import { checkedMutation } from "@armada/plugin-api/guard";

import { testMerge } from "./test-merge.ts";

const execute = promisify(execFileCallback);
const DEFAULT_OUTPUT_TAIL = 64 * 1024;
const DEFAULT_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_KILL_TIMEOUT_MS = 1_000;
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
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number;
  readonly outputTail: number;
  readonly deliveries: Map<string, string>;
  readonly started: Promise<void>;
  readonly closed: Promise<void>;
  state: WorkerObservation["state"];
  output: string;
  startError?: Error;
  stopping: boolean;
  closedValue: boolean;
  stopPromise?: Promise<void>;
  resolveStarted: () => void;
  rejectStarted: (error: Error) => void;
  resolveClosed: () => void;
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
    outputTail: positiveInteger(options.outputTail, DEFAULT_OUTPUT_TAIL, "outputTail"),
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
    if (!request.command || request.command.includes("\0")) throw invalidInput("command is empty or contains NUL");
    if (request.args.some((arg) => arg.includes("\0"))) throw invalidInput("argument contains NUL");

    return withWorkspaceLock(workspace, async () => {
      if (workspace.removed) throw new Error("workspace has already been disposed");
      if (this.#activeWorker(workspace)) throw new Error("workspace already has an active worker");
      const ref: WorkerRef = { ...request.worker, handle: randomUUID() };
      const usePty = await this.#usePty();
      const spec = this.#spawnSpec(request, usePty);
      let record!: WorkerRecord;
      await checkedMutation(request.worker, () => {
        const child = spawn(spec.command, spec.args, {
          cwd: workspace.workspace.path,
          detached: process.platform !== "win32",
          env: workerEnvironment(request.env),
          shell: false,
          stdio: "pipe",
          windowsHide: true,
        });
        record = this.#record(ref, workspace, child);
        this.#workers.set(ref.handle, record);
        this.#attach(record);
        return undefined;
      });
      try {
        await record.started;
      } catch (error) {
        if (record.pid < 1 && record.startError) {
          await record.closed;
          return ref;
        }
        await this.#stopRecord(record, ref).catch(() => {});
        throw error;
      }
      return ref;
    });
  }

  async deliver(worker: WorkerRef, message: string, deliveryKey: string): Promise<void> {
    if (!deliveryKey) throw invalidInput("delivery key is empty");
    const record = this.#worker(worker);
    return withWorkspaceLock(record.workspace, async () => {
      const current = this.#worker(worker);
      if (current !== record) throw staleWorker();
      const previous = current.deliveries.get(deliveryKey);
      if (previous !== undefined) {
        if (previous !== message) throw new Error("delivery key was reused with a different message");
        return;
      }
      if (current.closedValue || current.state !== "running") throw new Error("worker is no longer running");
      await checkedMutation(worker, () => {
        const latest = this.#worker(worker);
        if (latest !== record || latest.closedValue || latest.state !== "running") throw staleWorker();
        const duplicate = latest.deliveries.get(deliveryKey);
        if (duplicate !== undefined) {
          if (duplicate !== message) throw new Error("delivery key was reused with a different message");
          return;
        }
        if (!latest.child.stdin.writable) throw new Error("worker input is closed");
        return new Promise<void>((resolvePromise, rejectPromise) => {
          latest.child.stdin.write(`${message}\n`, (error) => {
            if (error) {
              rejectPromise(error);
              return;
            }
            latest.deliveries.set(deliveryKey, message);
            resolvePromise();
          });
        });
      });
    });
  }

  async observe(worker: WorkerRef): Promise<WorkerObservation> {
    const record = this.#worker(worker);
    return { state: record.state, reply: record.output };
  }

  async stop(worker: WorkerRef): Promise<void> {
    const record = this.#worker(worker);
    if (record.stopPromise) return record.stopPromise;
    let operation!: Promise<void>;
    operation = withWorkspaceLock(record.workspace, async () => {
      const current = this.#worker(worker);
      if (current !== record) throw staleWorker();
      await this.#stopRecord(current, worker);
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

  #worker(worker: WorkerRef): WorkerRecord {
    const record = this.#workers.get(worker.handle);
    if (!record || !sameWorker(record.ref, worker)) throw staleWorker();
    return record;
  }

  #activeWorker(workspace: WorkspaceRecord): WorkerRecord | undefined {
    for (const record of this.#workers.values())
      if (record.workspace === workspace && !record.closedValue) return record;
    return undefined;
  }

  #record(ref: WorkerRef, workspace: WorkspaceRecord, child: ChildProcessWithoutNullStreams): WorkerRecord {
    let resolveStarted!: () => void;
    let rejectStarted!: (error: Error) => void;
    const started = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveStarted = resolvePromise;
      rejectStarted = (error) => rejectPromise(error);
    });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolvePromise) => {
      resolveClosed = resolvePromise;
    });
    const record: WorkerRecord = {
      ref: { ...ref },
      workspace,
      child,
      pid: child.pid ?? -1,
      outputTail: this.#options.outputTail,
      deliveries: new Map(),
      started,
      closed,
      resolveStarted,
      rejectStarted,
      resolveClosed,
      state: "starting",
      output: "",
      stopping: false,
      closedValue: false,
    };
    // Node and Bun expose a child pid synchronously. Resolve startup here as
    // well as on `spawn` so a fast host implementation cannot race listener
    // registration.
    if (child.pid !== undefined) {
      record.state = "running";
      record.resolveStarted();
    }
    return record;
  }

  #attach(record: WorkerRecord): void {
    const append = (chunk: unknown) => {
      const text = textOf(chunk);
      record.output = `${record.output}${text}`.slice(-record.outputTail);
    };
    record.child.stdout.on("data", append);
    record.child.stderr.on("data", append);
    record.child.stdin.on("error", (error) => {
      if (!record.stopping && !record.closedValue) {
        record.state = "failed";
        append(`\n${error.message}\n`);
      }
    });
    record.child.once("spawn", () => {
      if (!record.closedValue) {
        record.state = "running";
        record.resolveStarted();
      }
    });
    record.child.once("error", (error) => {
      if (!record.closedValue) {
        record.state = "failed";
        if (record.pid < 1) record.startError = error;
        record.rejectStarted(error);
        append(`\n${error.message}\n`);
      }
    });
    record.child.once("close", (code, signal) => {
      record.closedValue = true;
      if (record.state === "starting") record.rejectStarted(new Error("worker process failed to start"));
      if (record.startError) record.state = "failed";
      else if (record.stopping || code === 0 || signal !== null) record.state = "stopped";
      else record.state = "failed";
      record.resolveClosed();
    });
  }

  async #stopRecord(record: WorkerRecord, worker: WorkerRef): Promise<void> {
    if (record.closedValue) return;
    await this.#signal(record, worker, "SIGTERM");
    if (await this.#waitForClose(record.closed, this.#options.stopTimeoutMs)) return;
    await this.#signal(record, worker, "SIGKILL");
    if (!(await this.#waitForClose(record.closed, this.#options.killTimeoutMs)))
      throw new Error("worker process did not stop after SIGKILL");
  }

  async #signal(record: WorkerRecord, worker: WorkerRef, signal: NodeJS.Signals): Promise<void> {
    await checkedMutation(worker, () => {
      const latest = this.#worker(worker);
      if (latest !== record || latest.closedValue || latest.pid < 1 || latest.child.pid !== latest.pid) return;
      latest.stopping = true;
      if (process.platform !== "win32") {
        try {
          process.kill(-latest.pid, signal);
          return;
        } catch (error) {
          // An exited group leader can yield EPERM on macOS before close arrives.
          if (!isErrno(error, "ESRCH") && !isErrno(error, "EPERM")) throw error;
        }
      }
      try {
        latest.child.kill(signal);
      } catch (error) {
        if (!isErrno(error, "ESRCH") && !isErrno(error, "EPERM")) throw error;
      }
    });
  }

  async #waitForClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolvePromise) => {
          timer = setTimeout(() => resolvePromise(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    deliver: node.deliver.bind(node),
    observe: node.observe.bind(node),
    stop: node.stop.bind(node),
    dispose: node.dispose.bind(node),
  };
}

export function activate(ctx: PluginContext): void {
  const options = (ctx.config.node?.local ?? {}) as LocalNodeOptions;
  ctx.register.node("local", createLocalNode(options));
}

export const plugin: ArmadaPlugin = { activate };
