import events from "./events.ts";
import exec from "./exec.ts";
import outputs from "./outputs.ts";

export const sandboxInspectionCommands = [exec, events, outputs] as const;
