import events from "./events.ts";
import exec from "./exec.ts";
import outputs from "./outputs.ts";
import portForward from "./port-forward.ts";
import shell from "./shell.ts";

export const sandboxInspectionCommands = [exec, shell, portForward, events, outputs] as const;
