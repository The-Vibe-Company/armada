import { antigravityLoginOperations, controlRouteKey } from "@armada/core/contract";
import { mutateCredentialAccount, resolveOrg, VaultError } from "@armada/core/server";
import { AntigravityLoginError } from "./antigravity-login.ts";
import type { ControlOptions } from "./control.ts";
import { scopedOrg } from "./control-caller.ts";
import { defineRoutes } from "./routes.ts";

const {
  startAntigravityLogin: start,
  completeAntigravityLogin: complete,
  cancelAntigravityLogin: cancel,
} = antigravityLoginOperations;
const startKey = controlRouteKey(start.route);
const errorCodes = {
  already_pending: "conflict",
  login_missing: "not_found",
  invalid_code: "invalid",
  login_failed: "unavailable",
} as const;

function loginService(options: ControlOptions, request?: Request) {
  if (!options.antigravityLogin) throw new VaultError("unavailable", "Antigravity sign-in is unavailable.");
  if (request) options.configureAntigravityLoginRequest?.(request);
  return options.antigravityLogin;
}

async function exchange<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AntigravityLoginError) throw new VaultError(errorCodes[error.reason], error.message);
    throw error;
  }
}

export const antigravityLoginRoutes = defineRoutes("antigravity-login-control", {
  [startKey]: async ({ caller, body, options, request }) => {
    const parsed = start.input.body.safeParse(body);
    if (!parsed.success) throw new VaultError("invalid", "Give an account name, or an ID and expected version.");
    const login = loginService(options, request);
    const { org, ...target } = parsed.data;
    const orgRef = scopedOrg(caller, org) ?? caller.orgs.map(({ orgId }) => orgId).sort()[0];
    const organization = await resolveOrg(options.store, caller.userId, orgRef);
    const membership = caller.orgs.find(({ orgId }) => orgId === organization.id);
    if (!membership || (org !== undefined && (organization.role !== "admin" || membership.role !== "admin")))
      throw new VaultError("forbidden", "You cannot sign in for this organization.");
    return start.output.parse(
      await exchange(() =>
        login.start(
          { userId: caller.userId, orgId: organization.id },
          { ...target, ...(org === undefined ? {} : { org: organization.id }) },
        ),
      ),
    );
  },
  [controlRouteKey(complete.route)]: {
    methods: [complete.route.method, cancel.route.method],
    pattern: /^model-accounts\/antigravity\/login\/[^/]+$/,
    handler: async ({ caller, route, body, options, request }) => {
      const login = loginService(options, request);
      const id = complete.input.path.loginId.safeParse(route.slice(startKey.length + 1));
      if (!id.success) throw new VaultError("not_found", "Start sign-in again.");
      const pending = caller.orgs
        .map(({ orgId, role }) => {
          const actor = { userId: caller.userId, orgId };
          return { actor, role, target: login.targetFor(actor, id.data) };
        })
        .find(({ target }) => target !== undefined);
      if (!pending?.target) throw new VaultError("not_found", "Start sign-in again.");
      const { actor } = pending;
      if (request?.method === cancel.route.method) {
        await exchange(() => login.cancel(actor, id.data));
        return cancel.output.parse({ ok: true });
      }
      if (pending.target.org !== undefined && pending.role !== "admin")
        throw new VaultError("forbidden", "Only an org admin can do that.");
      const parsed = complete.input.body.safeParse(body);
      if (!parsed.success) throw new VaultError("invalid", "Enter the code or callback URL from Google.");
      const { target, credential } = await exchange(() => login.complete(actor, id.data, parsed.data.code));
      const account = await mutateCredentialAccount(options.store, options.encryptionKey, actor.userId, {
        ...target,
        scope: target.org === undefined ? "user" : "org",
        action: "set",
        kind: "antigravity",
        value: JSON.stringify(credential),
      });
      return complete.output.parse({ account });
    },
  },
});
