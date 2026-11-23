import { operation } from "../operations.ts";
import type { Command } from "./command.ts";

type SandboxOperationName = Parameters<typeof operation>[0];

export function sandboxOperation(metadata: Omit<Command, "run" | "name"> & { name: SandboxOperationName }): Command {
  return {
    ...metadata,
    automaticJson: true,
    useSelectedOrg: true,
    run: (argv, { auth, deps }) => operation(metadata.name, argv, auth, deps.sandboxFile),
  };
}
