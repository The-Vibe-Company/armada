import type { AuthIo } from "../auth-commands.ts";
import type { Deps, Io } from "../run.ts";

export type UsageGroup = "docker-launch" | "launch" | "list" | "advice" | "sandbox";

export type Command = {
  name: string;
  summary: string;
  /** Top-level usage, placed in the sandbox block by default. */
  usage: string | Partial<Record<UsageGroup, string>>;
  help: string;
  /** Legacy help entry that follows this command in shell option discovery. */
  completionBefore?: string;
  useSelectedOrg?: boolean;
  run: (argv: readonly string[], context: { io: Io; deps: Deps; auth: AuthIo }) => Promise<number>;
};
