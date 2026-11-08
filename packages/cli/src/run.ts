import { VERSION } from "@armada/core";
import { GOLDEN_HELP, type RunDeps, runGolden } from "./golden-command.ts";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export type { RunDeps };

const HELP = `armada ${VERSION}: launch coding agents on boat.dev

Usage:
  armada --version   Print the version
  armada --help      Show this help

${GOLDEN_HELP}`;

/** Runs one command line and returns the process exit code. */
export async function run(argv: readonly string[], io: Io, deps?: RunDeps): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "--version":
    case "-v":
      io.out(`${VERSION}\n`);
      return 0;
    case undefined:
    case "--help":
    case "-h":
    case "help":
      io.out(HELP);
      return 0;
    case "golden":
      return runGolden(rest, io, deps ?? {});
    default:
      io.err(`armada: unknown command '${command}'. Run 'armada --help'.\n`);
      return 2;
  }
}
