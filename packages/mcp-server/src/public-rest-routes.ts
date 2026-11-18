/**
 * The integration REST contract inventory. `docs/openapi.json` publishes exactly
 * `PUBLISHED_REST_ROUTES` and `PUBLISHED_REST_GET_ROUTES`. Every other route that the public dashboard endpoint
 * (`/api/v1/*`) forwards must have a reason in `UNPUBLISHED_REST_ROUTES`. The
 * dashboard proxy test checks both directions, so a new forwarded route cannot
 * silently fall outside the description. This module imports nothing.
 *
 * `PUBLISHED_REST_ROUTES` are POST operations of the control dispatcher;
 * `PUBLISHED_REST_GET_ROUTES` are GET operations whose path carries parameters.
 */
export const PUBLISHED_REST_ROUTES = [
  // Discovery: what a launch can ask for, and which goldens it can name.
  "launch/options",
  "golden/list",
  "golden/capabilities",
  "golden/adopt",
  "github/refresh",
  "github/runtime-status",
  "sandbox/list",
  "sandbox/detail",
  "sandbox/status",
  "sandbox/recovery",
  "sandbox/advice",
  "sandbox/send",
  "sandbox/resume",
  "sandbox/report",
  "sandbox/stop",
  "sandbox/extend",
  "sandbox/delete",
  "sandbox/wait",
  "sandbox/exec",
  "sandbox/steer",
  "sandbox/interrupt",
  "sandbox/launch",
  "templates/launch",
  "logs/read",
] as const;

/** Published GET operations with path parameters (`{name}` is one percent-encoded segment). */
export const PUBLISHED_REST_GET_ROUTES = ["sandboxes/{id}/outputs", "sandboxes/{id}/outputs/{name}"] as const;

/**
 * Forwarded routes outside the integration description, by exact route or by a
 * namespace ending in "/". Sandbox, golden, launch and logs routes are listed one by
 * one, so a new route there must be published or given a reason.
 */
export const UNPUBLISHED_REST_ROUTES: Readonly<Record<string, string>> = {
  "auth/": "Interactive sign-in for the CLI and dashboard; integrations use service tokens.",
  "github/oauth/callback": "Browser OAuth redirect target.",
  "account/": "Signed-in account session management.",
  "token/": "Service token administration.",
  "org/": "Organization administration.",
  "members/": "Organization membership administration.",
  "creds/": "Model credential administration.",
  "mcp/": "MCP connection administration.",
  "docker/": "Docker host and snapshot administration.",
  "routines/": "Routine administration.",
  "variables/": "Readable variable administration.",
  "secrets/": "Application secret administration.",
  "skillpack/": "Skill catalog administration.",
  "skills/": "Skill default administration.",
  "templates/create": "Template authoring.",
  "templates/list": "Template authoring.",
  "templates/get": "Template authoring.",
  "templates/publish": "Template authoring.",
  "templates/delete": "Template authoring.",
  "github/status": "GitHub connection administration.",
  "github/connect": "GitHub connection administration.",
  "github/reconnect": "GitHub connection administration.",
  "github/disconnect": "GitHub connection administration.",
  "github/install": "GitHub connection administration.",
  "golden/size-policy": "Golden administration.",
  "golden/create": "Golden builds.",
  "golden/update": "Golden builds.",
  "golden/update-add-repos": "Golden builds.",
  "golden/snapshot": "Golden builds.",
  "golden/connect": "Golden builds.",
  "golden/build/status": "Golden builds.",
  "golden/build/find": "Golden builds.",
  "golden/build/cancel": "Golden builds.",
  "golden/remove": "Golden administration.",
  "golden/visibility": "Golden administration.",
  "golden/retirement/dry-run": "Golden snapshot retirement administration.",
  "golden/retirement/reconcile": "Golden snapshot retirement administration.",
  "sandbox/bind-credential": "Dashboard credential repair.",
  "sandbox/test-model-connection": "Dashboard credential check.",
  "sandboxes/{id}": "Dashboard sandbox deletion (DELETE).",
};

/** Why a forwarded route is outside the description, or undefined when it has no reason. */
export function unpublishedReason(route: string): string | undefined {
  if (Object.hasOwn(UNPUBLISHED_REST_ROUTES, route)) return UNPUBLISHED_REST_ROUTES[route];
  const namespace = Object.keys(UNPUBLISHED_REST_ROUTES).find(
    (key) => key.endsWith("/") && route.startsWith(key) && key !== route,
  );
  return namespace === undefined ? undefined : UNPUBLISHED_REST_ROUTES[namespace];
}
