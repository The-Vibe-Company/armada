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
}

/** Runs a program (git, gh) without a shell and returns its exit code and output. */
export type Exec = (command: string, args: string[], options: { cwd: string }) => Promise<ExecResult>;

/**
 * Runs a command with its own standard input and output and the environment
 * given, and returns its exit code: `armada run` (THE-859).
 */
export type Spawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => Promise<number>;

/** Every side effect a command may have, injected so commands can be tested. */
export interface Io {
  machineName?: string;
  ttyName?: string | null;
  cwd: string;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string | null>;
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
  /** Replaces the Linear write adapter (tests use an in-memory fake). */
  linearWriter?: (options: LinearWriterOptions) => LinearWriter;
  /** Runs git and gh; required by doctor, init and merge. */
  exec?: Exec;
  /** Runs the command of `armada run`, attached to this terminal. */
  spawn?: Spawn;
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
