import type { AuthIo } from "../auth-commands.ts";
import type { Deps, Io } from "../run.ts";

export type UsageGroup =
  | "org"
  | "host"
  | "docker-launch"
  | "new"
  | "ls"
  | "sandbox"
  | "setup"
  | "session"
  | "account"
  | "automation"
  | "vault"
  | "mcp"
  | "mcp-bindings"
  | "bind-credential"
  | "snapshots";

export type Command = {
  name: string;
  summary: string;
  usage: string | Partial<Record<UsageGroup, string>>;
  help: string;
  subcommandHelp?: Readonly<Record<string, string>>;
  automaticJson?: boolean;
  helpWhenBare?: boolean;
  validateProfileForHelp?: boolean;
  requireKnownSubcommand?: boolean;
  useSelectedOrg?: boolean | ((argv: readonly string[]) => boolean);
  run: (argv: readonly string[], context: { io: Io; deps: Deps; auth: AuthIo }) => Promise<number>;
};
