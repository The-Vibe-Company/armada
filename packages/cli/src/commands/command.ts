import type { AuthIo } from "../auth-commands.ts";
import type { Deps, Io } from "../run.ts";

export type UsageGroup =
  | "invitations"
  | "org"
  | "host"
  | "docker-launch"
  | "launch"
  | "list"
  | "advice"
  | "sandbox"
  | "logs"
  | "setup"
  | "session"
  | "account";

export type Command = {
  name: string;
  summary: string;
  usage: string | Partial<Record<UsageGroup, string>>;
  help: string;
  subcommandHelp?: Readonly<Record<string, string>>;
  helpWhenBare?: boolean;
  validateProfileForHelp?: boolean;
  completionBefore?: string;
  useSelectedOrg?: boolean | ((argv: readonly string[]) => boolean);
  run: (argv: readonly string[], context: { io: Io; deps: Deps; auth: AuthIo }) => Promise<number>;
};
