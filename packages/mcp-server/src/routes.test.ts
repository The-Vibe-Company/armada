import { expect, test } from "bun:test";
import { controlRoutes } from "./modules.ts";
import { defineRoutes, registerRoutes } from "./routes.ts";

test("registered control commands preserve their HTTP methods and names", () => {
  const routes = Array.from(controlRoutes, ([route, { method }]) => `${method} /${route}`).sort();
  expect(routes).toMatchInlineSnapshot(`
    [
      "POST /golden/adopt",
      "POST /golden/build/cancel",
      "POST /golden/build/find",
      "POST /golden/build/status",
      "POST /golden/capabilities",
      "POST /golden/connect",
      "POST /golden/create",
      "POST /golden/list",
      "POST /golden/remove",
      "POST /golden/retirement/dry-run",
      "POST /golden/retirement/reconcile",
      "POST /golden/size-policy",
      "POST /golden/snapshot",
      "POST /golden/update",
      "POST /golden/update-add-repos",
      "POST /golden/visibility",
      "POST /launch/options",
      "POST /launch/resolve",
      "POST /sandbox/advice",
      "POST /sandbox/bind-credential",
      "POST /sandbox/checkpoint-runtime-v1",
      "POST /sandbox/delete",
      "POST /sandbox/detail",
      "POST /sandbox/exec",
      "POST /sandbox/extend",
      "POST /sandbox/github-preflight-v1",
      "POST /sandbox/interrupt",
      "POST /sandbox/launch",
      "POST /sandbox/list",
      "POST /sandbox/mcp-preflight-v1",
      "POST /sandbox/recovery",
      "POST /sandbox/report",
      "POST /sandbox/resume",
      "POST /sandbox/resume-runtime-v1",
      "POST /sandbox/send",
      "POST /sandbox/status",
      "POST /sandbox/steer",
      "POST /sandbox/stop",
      "POST /sandbox/test-model-connection",
      "POST /sandbox/wait",
      "POST /templates/launch",
    ]
  `);
});

test("registry construction rejects duplicate routes with both module names", () => {
  const first = defineRoutes("first", { "sandbox/list": () => null });
  const second = defineRoutes("second", { "sandbox/list": () => null });
  expect(() => registerRoutes([first, second])).toThrow(
    'Duplicate control route "sandbox/list" in modules "first" and "second".',
  );
});
