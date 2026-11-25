import { expect, test } from "bun:test";
import { type EventsRequest, eventPageOptions, MAX_SANDBOX_EXTENSION_TTL_SECONDS } from "@armada/core";
import { type ControlOptions, dispatchControlCommand } from "./control.ts";
import { readVaultControlBody } from "./control-body.ts";
import { controlFailureResponse } from "./control-errors.ts";
import { controlRoutes } from "./modules.ts";
import { defineRoutes, registerRoutes } from "./routes.ts";
import { ToolApiError } from "./tool-api.ts";

test("registered command routes preserve their HTTP methods and names", () => {
  const routes = Array.from(controlRoutes, ([route, { methods }]) => methods.map((method) => `${method} /${route}`))
    .flat()
    .sort();
  expect(routes).toMatchInlineSnapshot(`
    [
      "DELETE /model-accounts/antigravity/login/{loginId}",
      "DELETE /sandboxes/{id}",
      "GET /auth/authorize",
      "GET /events",
      "GET /github/oauth/callback",
      "POST /account/logout",
      "POST /account/status",
      "POST /auth/device/decide",
      "POST /auth/device/inspect",
      "POST /auth/device/poll",
      "POST /auth/device/start",
      "POST /auth/email/start",
      "POST /auth/email/verify",
      "POST /auth/exchange",
      "POST /auth/refresh",
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
      "POST /github/connect",
      "POST /github/disconnect",
      "POST /github/install",
      "POST /github/oauth/callback",
      "POST /github/reconnect",
      "POST /github/refresh",
      "POST /github/runtime-status",
      "POST /github/status",
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
      "POST /logs/read",
      "POST /mcp/catalog",
      "POST /mcp/connect",
      "POST /mcp/create",
      "POST /mcp/delete",
      "POST /mcp/list",
      "POST /mcp/metadata",
      "POST /mcp/oauth/callback",
      "POST /mcp/revoke",
      "POST /mcp/sandbox-connections",
      "POST /mcp/set-enabled",
      "POST /mcp/status",
      "POST /mcp/update",
      "POST /members/add",
      "POST /members/list",
      "POST /members/remove",
      "POST /members/role",
      "POST /model-accounts/antigravity/login",
      "POST /model-accounts/antigravity/login/{loginId}",
      "POST /org/create",
      "POST /org/invitations/accept",
      "POST /org/invitations/create",
      "POST /org/invitations/list",
      "POST /org/invitations/preview",
      "POST /org/invitations/resend",
      "POST /org/invitations/revoke",
      "POST /org/list",
      "POST /org/provider/connect",
      "POST /org/provider/disconnect",
      "POST /org/provider/status",
      "POST /routines/create",
      "POST /routines/delete",
      "POST /routines/enable",
      "POST /routines/get",
      "POST /routines/history",
      "POST /routines/list",
      "POST /routines/pause",
      "POST /routines/preview",
      "POST /routines/update",
      "POST /sandbox/advice",
      "POST /sandbox/bind-credential",
      "POST /sandbox/checkpoint-runtime-v1",
      "POST /sandbox/exec",
      "POST /sandbox/extend",
      "POST /sandbox/github-preflight-v1",
      "POST /sandbox/interrupt",
      "POST /sandbox/launch",
      "POST /sandbox/list",
      "POST /sandbox/list-turns",
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
      "POST /sandbox/viewer-token",
      "POST /sandbox/wait",
      "POST /sandboxes/{id}/relay-ticket",
      "POST /secrets/commit",
      "POST /secrets/delete",
      "POST /secrets/list",
      "POST /secrets/revoke",
      "POST /secrets/rotate",
      "POST /secrets/set",
      "POST /secrets/upload",
      "POST /skillpack/catalog",
      "POST /skillpack/connection",
      "POST /skillpack/versions",
      "POST /skills/defaults/get",
      "POST /skills/defaults/set",
      "POST /templates/create",
      "POST /templates/delete",
      "POST /templates/get",
      "POST /templates/launch",
      "POST /templates/list",
      "POST /templates/publish",
      "POST /token/create",
      "POST /token/list",
      "POST /token/revoke",
      "POST /token/whoami",
      "POST /variables/delete",
      "POST /variables/list",
      "POST /variables/read",
      "POST /variables/revoke",
      "POST /variables/set",
      "POST /variables/update",
      "POST /viewer/logs",
      "POST /viewer/send",
      "POST /viewer/status",
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

const caller = { via: "supabase" as const, userId: "owner", orgs: [] };
const options = {
  data: () => ({
    sandboxes: {
      get: async () => {
        throw new Error("Validation must run before sandbox reads.");
      },
      list: async () => {
        throw new Error("Validation must run before sandbox reads.");
      },
    },
  }),
  providers: {},
} as unknown as ControlOptions;

test.each([
  ["sandbox/list", { limit: 0 }],
  ["sandbox/status", { id: 42 }],
  ["sandbox/send", { id: "sandbox", prompt: "" }],
  ["sandbox/stop", { id: "sandbox", only_if_idle: "true" }],
  ["sandbox/report", { id: "sandbox", prompt_id: "turn", outcome: { state: "ready", prNumber: 0 } }],
  ["sandbox/wait", { id: "sandbox", timeout_seconds: 601 }],
  ["sandbox/steer", { id: "sandbox", text: "" }],
  ["sandbox/interrupt", { id: "sandbox", request_id: "invalid" }],
  ["sandbox/exec", { id: "sandbox", command: "", timeout_seconds: 0 }],
  ["sandbox/resume", { id: "sandbox", request_id: "invalid" }],
  ["sandbox/extend", { id: 42, ttlSeconds: 60 }],
  ["sandbox/advice", { id: 42 }],
  ["sandbox/recovery", { id: "sandbox", recovery_id: "invalid" }],
  [
    "sandbox/checkpoint-runtime-v1",
    { id: "sandbox", request_id: "42ec79bb-0baa-452e-a5c8-0a788e16e880", runtimeVersion: 2 },
  ],
  [
    "sandbox/resume-runtime-v1",
    { id: "sandbox", request_id: "42ec79bb-0baa-452e-a5c8-0a788e16e880", runtimeVersion: 1, prompt: "" },
  ],
] as const)("%s keeps its REST validation code and refuses before touching sandbox data", async (route, body) => {
  const error = await dispatchControlCommand(route, caller, body, options).catch((reason) => reason);
  if (!(error instanceof ToolApiError)) throw new Error("Expected a REST validation refusal.", { cause: error });
  expect(error.message).toContain("Input validation error");
  const response = controlFailureResponse(error);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "internal" } });
});

test.each([
  ["sandbox/bind-credential", { org: 42 }, 400, "invalid", "org must be text."],
  [
    "sandbox/test-model-connection",
    { id: "sandbox", model: "deployment" },
    400,
    "invalid",
    "id must be an Armada sandbox UUID.",
  ],
  ["sandbox/mcp-preflight-v1", { runtimeVersion: 2 }, 503, "dependency_unavailable", "Runtime MCP v1 is unavailable."],
  [
    "sandbox/mcp-preflight-v1",
    { runtimeVersion: 1, toolInventory: "true" },
    400,
    "invalid",
    "toolInventory must be boolean.",
  ],
  [
    "sandbox/github-preflight-v1",
    { runtimeVersion: 1, org: "example", golden: "base", repository: null },
    400,
    "invalid",
    "repository is required.",
  ],
  ["sandbox/list-turns", { org: "not-a-uuid" }, 400, "invalid", "org must be text."],
] as const)("%s preserves the refusal for %j", async (route, body, status, code, message) => {
  const preflight = () => {
    throw new Error("Invalid input reached the preflight service.");
  };
  const error = await dispatchControlCommand(route, caller, body, {
    ...options,
    runtimeMcp: { preflight } as unknown as NonNullable<ControlOptions["runtimeMcp"]>,
    runtimeGitHub: { preflight } as unknown as NonNullable<ControlOptions["runtimeGitHub"]>,
  }).catch((reason) => reason);
  const response = controlFailureResponse(error);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code, message } });
});

test.each([
  [{ ttlSeconds: 1.5 }, "invalid"],
  [{ ttlSeconds: Number.MAX_SAFE_INTEGER + 1 }, "invalid"],
  [{ ttlSeconds: MAX_SANDBOX_EXTENSION_TTL_SECONDS + 1 }, "extension_maximum"],
] as const)("sandbox extension keeps the lifetime refusal for %j", async (body, code) => {
  const error = await dispatchControlCommand("sandbox/extend", caller, { id: "sandbox", ...body }, options).catch(
    (reason) => reason,
  );
  const response = controlFailureResponse(error);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code } });
});

test.each([
  [{ id: null }, "id is required."],
  [{ id: 42 }, "id must be text."],
  [{ org: 42 }, "org must be text."],
  [{ direction: "sideways" }, "Invalid event direction."],
  [{ direction: "backward", all: true }, "Backward reads cannot drain all pages."],
  [{ limit: "1" }, "Invalid event pagination."],
  [{ maxBytes: "256" }, "Invalid event pagination."],
  [{ coalesce: "true" }, "Invalid coalesce option."],
  [{ cursor: 42 }, "cursor must be text."],
] as const)("REST logs preserve the invalid refusal for %j", async (body, message) => {
  const error = await dispatchControlCommand(
    "logs/read",
    caller,
    { id: "sandbox", ...body },
    {
      ...options,
      logs: async () => ({
        providerSandboxId: "provider-sandbox",
        provider: {
          events: async () => {
            throw new Error("Invalid pagination must not read events.");
          },
        } as never,
      }),
    },
  ).catch((reason) => reason);
  const response = controlFailureResponse(error);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid", message } });
});

test("REST logs leave out-of-range numbers to provider pagination validation", async () => {
  const error = await dispatchControlCommand("logs/read", caller, JSON.parse('{"id":"sandbox","limit":1e400}'), {
    ...options,
    logs: async () => ({
      providerSandboxId: "provider-sandbox",
      provider: {
        events: (request: EventsRequest) => eventPageOptions(request, "modal"),
      } as never,
    }),
  }).catch((reason) => reason);
  const response = controlFailureResponse(error);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
});

test("the strict control reader enforces the caller's byte limit", async () => {
  const request = () => new Request("https://armada.test/api/v1/skillpack/catalog", { method: "POST", body: "{}" });
  expect(await readVaultControlBody(request(), 2)).toEqual({});
  await expect(readVaultControlBody(request(), 1)).rejects.toMatchObject({ code: "invalid" });
});
