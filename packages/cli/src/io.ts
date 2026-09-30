import type { Fetch, LinearWriter, LinearWriterOptions } from "@armada/core";

/** Every side effect a command may have, injected so commands can be tested. */
export interface Io {
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
  /** Replaces the Linear write adapter (tests use an in-memory fake). */
  linearWriter?: (options: LinearWriterOptions) => LinearWriter;
}

/** A mistake in how the command was called or configured: exit code 2. */
export class UsageError extends Error {}
