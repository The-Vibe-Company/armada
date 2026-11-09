import { type ArmadaApiOptions, ControlError, controlPost } from "./control.ts";
import {
  ACCOUNT_KINDS,
  type AccountScope,
  type AccountUsage,
  type AuthCapabilities,
  type ModelAccount,
  parseAccount,
  parseAuthCapabilities,
  parseUsage,
} from "./model-accounts.ts";

function isModelKind(kind: unknown): boolean {
  return (ACCOUNT_KINDS as readonly unknown[]).includes(kind);
}

/**
 * The control API for named model accounts (#603), as the signed-in viewer: `creds/list` lists them, and
 * `creds/accounts/{set,rename,default,remove}` change them by id under the server's own owner/admin checks. A
 * secret pasted for an account travels once in a request body; every answer is the safe account DTO.
 */
export const ACCOUNT_ROUTES = {
  list: "creds/list",
  set: "creds/accounts/set",
  rename: "creds/accounts/rename",
  default: "creds/accounts/default",
  remove: "creds/accounts/remove",
  /** #604's proposed read, relayed by root and not yet final: `{id, sandboxId?}` to `{accountId, version, ...}`. */
  usage: "creds/accounts/usage",
  /** #604: how accounts can be connected on this deployment. Its absence means paste only. */
  authCapabilities: "creds/accounts/auth-capabilities",
} as const;

/** One account, as the routes address it: its scope, the org for an org account, and its id. */
export type AccountTarget = { scope: AccountScope; org?: string; id: string };

/** Creates an account, or with `id` rotates its secret; `expectedVersion` refuses a stale rotation. */
export type SetAccountRequest = Omit<AccountTarget, "id"> & {
  id?: string;
  kind: string;
  name: string;
  value: string;
  expectedVersion?: number;
};

const FEATURE = "named model accounts";
/** What `controlPost` says for a route this server does not know. */
const NOT_OFFERED = "This Armada server does not offer account usage yet.";

/**
 * `creds/list {org}`'s `{user: [...], orgs: [{id, credentials: [...]}]}`, reduced to the model accounts of the
 * viewer and of that one org. A row without the account fields (a hosting key, an older server) is not an account
 * and is left out; scope comes from where the row sits, never from the row itself.
 */
export function accountsFromList(
  payload: Record<string, unknown>,
  org: string,
): { accounts: ModelAccount[]; legacy: boolean } {
  let legacy = false;
  const rows = (items: unknown, scope: AccountScope) =>
    (Array.isArray(items) ? items : [])
      .map((item) => {
        if (typeof item !== "object" || item === null) return null;
        const account = parseAccount({ ...item, scope });
        // A model credential without an id is a row from a server older than named accounts.
        if (!account && isModelKind((item as { kind?: unknown }).kind) && !("id" in item)) legacy = true;
        return account;
      })
      .filter((row): row is ModelAccount => row !== null);
  const orgs = Array.isArray(payload.orgs) ? payload.orgs : [];
  const mine = orgs.find((item) => typeof item === "object" && item !== null && (item as { id?: unknown }).id === org);
  const accounts = [
    ...rows(payload.user, "user"),
    ...rows((mine as { credentials?: unknown } | undefined)?.credentials, "org"),
  ];
  return { accounts, legacy };
}

export function createAccountControl(options: ArmadaApiOptions) {
  const post = (route: string, body: object) => controlPost(options, `/api/v1/${route}`, body, FEATURE);

  async function account(route: string, body: object): Promise<ModelAccount> {
    const payload = await post(route, body);
    const scope = (body as { scope?: unknown }).scope;
    const parsed = parseAccount(typeof payload.account === "object" ? { scope, ...payload.account } : null);
    if (!parsed) throw new ControlError("The Armada server sent an unexpected account.");
    return parsed;
  }

  return {
    async list(org: string): Promise<{ accounts: ModelAccount[]; legacy: boolean }> {
      const payload = await post(ACCOUNT_ROUTES.list, { org });
      if (!Array.isArray(payload.user)) throw new ControlError("The Armada server sent no credential list.");
      return accountsFromList(payload, org);
    },
    /** Creates an account, or with `id` rotates its secret; `expectedVersion` refuses a stale rotation. */
    set: (body: SetAccountRequest) => account(ACCOUNT_ROUTES.set, body),
    /** Only the name changes; #603 does not version names, so no `expectedVersion`. */
    rename: (target: AccountTarget & { name: string }) => account(ACCOUNT_ROUTES.rename, target),
    makeDefault: (target: AccountTarget) => account(ACCOUNT_ROUTES.default, target),
    remove: (target: AccountTarget) => post(ACCOUNT_ROUTES.remove, target).then(() => undefined),
    /**
     * How accounts can be connected here, or null when the server does not say (an unknown route, or an answer
     * that does not match): the dashboard then offers paste only, never a command the server did not report.
     */
    async authCapabilities(org: string): Promise<AuthCapabilities | null> {
      try {
        const payload = await controlPost(options, `/api/v1/${ACCOUNT_ROUTES.authCapabilities}`, { org }, FEATURE);
        return parseAuthCapabilities(payload.capabilities ?? payload);
      } catch (error) {
        if (error instanceof ControlError) return null;
        throw error;
      }
    },
    /**
     * One account's usage. `null` is a server that does not report usage (the route is unknown to it); any other
     * failure is thrown, and the caller shows it as a failed read rather than as an empty allowance.
     */
    async usage(id: string): Promise<AccountUsage | null> {
      let payload: Record<string, unknown>;
      try {
        payload = await controlPost(options, `/api/v1/${ACCOUNT_ROUTES.usage}`, { id }, "account usage");
      } catch (error) {
        // Only the unknown-route answer means "not offered"; a 404 for the account itself is a real failure.
        if (error instanceof ControlError && error.message === NOT_OFFERED) return null;
        throw error;
      }
      const parsed = parseUsage(payload.usage ?? payload);
      if (!parsed || parsed.accountId !== id) throw new ControlError("The Armada server sent unexpected usage.");
      return parsed;
    },
  };
}

export type AccountControl = ReturnType<typeof createAccountControl>;
