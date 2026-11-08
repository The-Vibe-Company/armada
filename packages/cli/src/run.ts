import { VERSION } from "@armada/core";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const HELP = `armada ${VERSION}: launch coding agents on boat.dev

Usage:
  armada --version   Print the version
  armada --help      Show this help
`;

/** Runs one command line and returns the process exit code. */
export function run(argv: readonly string[], io: Io): number {
  const [command] = argv;
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
    default:
      io.err(`armada: unknown command '${command}'. Run 'armada --help'.\n`);
      return 2;
  }
}
