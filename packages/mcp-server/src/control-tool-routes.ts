/** REST routes dispatched through the validated MCP contracts. */
export const CONTROL_TOOL_ROUTES: Readonly<Record<string, string>> = {
  "github/refresh": "github_refresh",
  "github/runtime-status": "runtime_github_status",
  "sandbox/list": "list",
  "sandbox/detail": "status",
  "sandbox/status": "status",
  "sandbox/send": "send",
  "sandbox/resume": "resume",
  "sandbox/report": "report",
  "sandbox/stop": "stop",
  "sandbox/extend": "extend",
  "sandbox/delete": "delete",
  "sandbox/wait": "wait",
  "sandbox/exec": "exec",
  "sandbox/steer": "steer",
  "sandbox/interrupt": "interrupt",
};
