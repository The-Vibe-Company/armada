import { operation } from "../operations.ts";
import type { Command } from "./command.ts";

type SandboxOperationName = Parameters<typeof operation>[0];

export function sandboxOperation(metadata: Omit<Command, "run" | "name"> & { name: SandboxOperationName }): Command {
  return {
    ...metadata,
    run: (argv, { auth }) => operation(metadata.name, argv, auth),
  };
}
