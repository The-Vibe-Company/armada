import type { AuthIo } from "../auth-commands.ts";
import type { Deps, Io } from "../run.ts";

export type UsageGroup =
  | "invitations"
  | "org"
  | "host"
  | "docker-launch"
  | "new"
  | "list"
  | "advice"
  | "sandbox"
  | "setup"
  | "session"
  | "account"
  | "automation"
  | "github"
  | "vault"
  | "mcp"
  | "mcp-bindings"
  | "bind-credential"
  | "snapshots"
  | "credential-setup"
  | "credential-accounts";

export type Command = {
  name: string;
  summary: string;
  usage: string | Partial<Record<UsageGroup, string>>;
  help: string;
  subcommandHelp?: Readonly<Record<string, string>>;
  automaticJson?: boolean;
  helpWhenBare?: boolean;
  validateProfileForHelp?: boolean;
  useSelectedOrg?: boolean | ((argv: readonly string[]) => boolean);
  run: (argv: readonly string[], context: { io: Io; deps: Deps; auth: AuthIo }) => Promise<number>;
};
