import type { AuthIo } from "../auth-commands.ts";
import type { Deps, Io } from "../run.ts";

export type UsageGroup = "sandboxes" | "interactive" | "templates" | "hosts" | "auth";

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
  useSelectedOrg?: true | ((argv: readonly string[]) => boolean);
  run: (argv: readonly string[], context: { io: Io; deps: Deps; auth: AuthIo }) => Promise<number>;
};
