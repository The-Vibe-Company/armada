import type { AuthIo } from "../auth-commands.ts";
import type { Deps, Io } from "../run.ts";

export type UsageGroup = "docker-launch" | "launch" | "list" | "advice" | "sandbox" | "logs";

export type Command = {
  name: string;
  summary: string;
  usage: string | Partial<Record<UsageGroup, string>>;
  help: string;
  completionBefore?: string;
  useSelectedOrg?: boolean;
  run: (argv: readonly string[], context: { io: Io; deps: Deps; auth: AuthIo }) => Promise<number>;
};
