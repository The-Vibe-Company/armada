import {
  type Fetch,
  type LinearWriter,
  type LinearWriterOptions,
  missingKeyMessage,
  type StoredKey,
} from "@armada/core";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The child exceeded its bound; mutating runtimes may have applied the request. */
  timedOut?: boolean;
}

/** Runs a program (git, gh) without a shell and returns its exit code and output. */
export type Exec = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; maxOutputBytes?: number; input?: string },
) => Promise<ExecResult>;

/**
 * Runs a command with its own standard input and output and the environment
 * given, and returns its exit code: `armada run` (THE-859).
 */
export type Spawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => Promise<number>;

export type WatchSignal = "SIGTERM" | "SIGINT" | "SIGHUP";
export interface ProcessIdentity {
  started: string;
  command: string;
  cwd: string;
}

/** Every side effect a command may have, injected so commands can be tested. */
export interface Io {
  /** Host platform; local runtime install offers support macOS and Linux. */
  platform?: NodeJS.Platform;
  machineName?: string;
  ttyName?: string | null;
  cwd: string;
  /** Output terminal width; absent for redirected output (80 columns). */
  terminalWidth?: number;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string | null>;
  /** Installed Codex model/list catalog for the current sign-in; null if unavailable. */
  codexModels?: (cwd: string) => Promise<string[] | null>;
  /** Save a model chosen by the owner in the existing repository configuration. */
  writeFile?: (path: string, text: string) => Promise<void>;
  readBinaryFile?: (path: string, maxBytes: number) => Promise<Uint8Array | null>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Token from the GitHub CLI (`gh auth token`), or null. */
  ghToken: () => string | null;
  fetch?: Fetch;
  now?: () => Date;
  /** True when a person can answer prompts (stdin and stderr are terminals). */
  interactive?: boolean;
  /**
   * Asks one question on the terminal and returns the answer, or null when the
   * person cancels (Ctrl-C). With `hidden`, typed characters are not echoed.
   */
  prompt?: (question: string, options: { hidden: boolean }) => Promise<string | null>;
  /** Current git branch of `cwd`, or null (detached head, not a repository). */
  gitBranch?: () => string | null;
  /** All of standard input, for `--message-file -`. */
  readStdin?: () => Promise<string>;
  /** Opens a URL in the person's browser; false when it could not. Best effort, never required. */
  openUrl?: (url: string) => boolean;
  /** Waits; tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
  /** This process's id, for the watch lock (default `process.pid`). */
  pid?: number;
  /** Whether a process still runs, for a watch lock left behind (default: signal 0). */
  processAlive?: (pid: number) => boolean;
  /** Process start identity, command and cwd, or null when it cannot be inspected. Never logged. */
  inspectProcess?: (pid: number) => Promise<ProcessIdentity | null>;
  /** Signals exactly one verified watch PID. */
  signalProcess?: (pid: number, signal: WatchSignal) => void | Promise<void>;
  /** Subscribes to watch shutdown signals; returns a function that removes the handlers. */
  onSignal?: (handler: (signal: WatchSignal) => void) => () => void;
  /** Replaces the Linear write adapter (tests use an in-memory fake). */
  linearWriter?: (options: LinearWriterOptions) => LinearWriter;
  /** Runs read-only local tool probes as well as git and gh. */
  exec?: Exec;
  /** Starts a persistent runtime server without a terminal, independent of this command. */
  detach?: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string | undefined> },
  ) => Promise<boolean>;
  /** Runs `armada run` or an explicitly accepted official installer, attached to this terminal. */
  spawn?: Spawn;
  startBackground?: (args: string[]) => Promise<boolean>;
  backgroundReady?: (ready: boolean) => void;
  stopped?: () => boolean;
}

/**
 * A mistake in how the command was called or configured: exit code 2. `next`
 * is the command to run next; without one, the command's own help is named.
 */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly next: string | null = null,
  ) {
    super(message);
  }
}

/** A key the command needs is not set: `armada auth login` stores it. */
export const missingKey = (key: StoredKey) => new UsageError(missingKeyMessage(key), "armada auth login");

/** Retry notices use the command's stderr and the same injected clock/waits as polling. */
export const httpOptions = (io: Io) => ({
  ...(io.fetch ? { fetch: io.fetch } : {}),
  ...(io.sleep ? { sleep: io.sleep } : {}),
  ...(io.now ? { now: io.now } : {}),
  onRetry: (message: string) => io.stderr(`armada: ${message}\n`),
});
