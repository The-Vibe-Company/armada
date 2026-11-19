/** REST routes dispatched through the validated MCP contracts. */
export const CONTROL_TOOL_ROUTES: Readonly<Record<string, string>> = {
  "sandbox/list": "list",
  "sandbox/detail": "status",
  "sandbox/status": "status",
  "sandbox/send": "send",
  "sandbox/report": "report",
  "sandbox/stop": "stop",
  "sandbox/wait": "wait",
  "sandbox/exec": "exec",
  "sandbox/steer": "steer",
  "sandbox/interrupt": "interrupt",
};
