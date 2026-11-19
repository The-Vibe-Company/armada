import { VaultError } from "@armada/core/server";
import { scopedOrg, selectedCaller } from "./control-caller.ts";
import { optional, UUID } from "./control-input.ts";
import { exposedSecrets, launchCredentials } from "./launch-credentials.ts";
import { measureRequestPhase } from "./request-timing.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";
import { sandboxListInput } from "./sandbox-tool-schemas.ts";
import { callSharedTool } from "./tool-api.ts";
import type { ToolContext } from "./tools.ts";

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

export const sandboxToolRoutes = defineRoutes(
  "sandbox tools",
  Object.fromEntries(
    Object.entries(CONTROL_TOOL_ROUTES).map(([route, toolName]) => [
      route,
      async (context: ControlRouteContext) => callSharedTool(await sandboxToolContext(context), toolName, context.body),
    ]),
  ),
);

export async function sandboxToolContext({ route, caller, body, options }: ControlRouteContext) {
  if (!options.data || !options.providers) throw new VaultError("unavailable", "Sandbox control is not configured.");
  const ref = optional(body, "org");
  const listRef =
    route === "sandbox/list" &&
    options.scopedSandboxData &&
    ref !== undefined &&
    sandboxListInput.safeParse(body).success
      ? scopedOrg(caller, ref)
      : undefined;
  const listOrgId = listRef && UUID.test(listRef.trim()) ? listRef.trim().toLowerCase() : undefined;
  const scopedCaller =
    listRef !== undefined
      ? listOrgId
        ? { ...caller, orgs: caller.orgs.filter((org) => org.orgId === listOrgId) }
        : caller
      : await selectedCaller(options, caller, ref);
  const context: ToolContext = {
    caller: scopedCaller,
    ...(options.sandboxBillingAccount
      ? { sandboxBillingAccount: (id: string) => options.sandboxBillingAccount!(scopedCaller, id) }
      : {}),
    ...(options.dockerControls ? { dockerControls: options.dockerControls } : {}),
    ...(options.runtimeSend ? { runtimeSend: options.runtimeSend } : {}),
    ...(options.accountTurns ? { accountTurns: options.accountTurns } : {}),
    ...(options.connections ? { connections: options.connections } : {}),
    data: listRef !== undefined ? options.scopedSandboxData!(scopedCaller, listRef) : options.data(scopedCaller),
    measure: (phase, work) => measureRequestPhase(options.timing, phase, work),
    storedProviders: options.storedProviderFor
      ? {
          modal: (target) =>
            measureRequestPhase(options.timing, "stored_provider", () =>
              options.storedProviderFor!(target, scopedCaller),
            ),
        }
      : {},
    provider: (target) =>
      measureRequestPhase(options.timing, "provider", () =>
        options.providers
          ? options.providers.resolve(target, scopedCaller)
          : Promise.reject(new VaultError("unavailable", "Resource providers are not configured.")),
      ),
    launchCredentials: launchCredentials(
      options.store,
      options.encryptionKey,
      options.github ? { ...options.github, store: options.store } : undefined,
      options.modelAuth,
    ),
    exposedSecrets: (orgId) => exposedSecrets(options.store, options.encryptionKey, { userId: caller.userId, orgId }),
    now: options.now ?? (() => new Date()),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  return context;
}
