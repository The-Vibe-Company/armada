import type { AuthIo } from "../auth-commands.ts";
import { operation } from "../operations.ts";

type CommandMetadata = {
  name: string;
  summary: string;
  /** Top-level usage row. Empty when another row already lists this command. */
  usage: string;
  help: string;
  usageGroup?: "list" | "advice";
  useSelectedOrg?: boolean;
};

type SandboxOperationName = Exclude<Parameters<typeof operation>[0], "mcp">;

export type Command = CommandMetadata & {
  run: (argv: readonly string[], auth: AuthIo) => Promise<number>;
};

export function sandboxOperation(metadata: CommandMetadata & { name: SandboxOperationName }): Command {
  return {
    ...metadata,
    run: (argv, auth) => operation(metadata.name, argv, auth, async () => ""),
  };
}
