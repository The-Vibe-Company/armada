import { sandboxOperations } from "@armada/core/contract";
import { VaultError } from "@armada/core/server";
import { scopedOrg, selectedCaller } from "./control-caller.ts";
import { optional, UUID } from "./control-input.ts";
import { exposedSecrets, launchCredentials } from "./launch-credentials.ts";
import { measureRequestPhase } from "./request-timing.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";
import { callSharedTool } from "./tool-api.ts";
import type { ToolContext } from "./tools.ts";

export const sandboxToolRoutes = defineRoutes(
  "sandbox tools",
  Object.fromEntries(
    Object.values(sandboxOperations).map((operation) => {
      const route = operation.route.path.slice("/api/v1/".length);
      return [
        route,
        async (context: ControlRouteContext) => {
          const parsed = operation.input.body.safeParse(context.body);
          return callSharedTool(
            await sandboxToolContext(context, parsed.success),
            operation.toolName,
            context.body,
            parsed,
          );
        },
      ];
    }),
  ),
);

export async function sandboxToolContext({ route, caller, body, options }: ControlRouteContext, validInput = false) {
  if (!options.data || !options.providers) throw new VaultError("unavailable", "Sandbox control is not configured.");
  const ref = optional(body, "org");
  const listRef =
    route === "sandbox/list" && options.scopedSandboxData && ref !== undefined && validInput
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
