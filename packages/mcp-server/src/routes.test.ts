import { expect, test } from "bun:test";
import { controlRoutes } from "./modules.ts";
import { defineRoutes, registerRoutes } from "./routes.ts";

test("registered command routes preserve their HTTP methods and names", () => {
  const routes = Array.from(controlRoutes, ([route, { method }]) => `${method} /${route}`).sort();
  expect(routes).toMatchInlineSnapshot(`
    [
      "POST /creds/accounts/auth-capabilities",
      "POST /creds/accounts/default",
      "POST /creds/accounts/limits",
      "POST /creds/accounts/models",
      "POST /creds/accounts/remove",
      "POST /creds/accounts/rename",
      "POST /creds/accounts/set",
      "POST /creds/accounts/usage",
      "POST /creds/defaults/set",
      "POST /creds/list",
      "POST /creds/rm",
      "POST /creds/set",
      "POST /launch/options",
      "POST /launch/resolve",
      "POST /members/add",
      "POST /members/list",
      "POST /members/remove",
      "POST /members/role",
      "POST /org/create",
      "POST /org/list",
      "POST /org/provider/connect",
      "POST /org/provider/disconnect",
      "POST /org/provider/status",
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
      "POST /skillpack/catalog",
      "POST /skillpack/connection",
      "POST /skillpack/versions",
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
