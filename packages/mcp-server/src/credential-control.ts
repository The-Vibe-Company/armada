import {
  listConnectionModels,
  mutateCredentialAccount,
  parseCredentialKind,
  removeCredential,
  resolveModelChoice,
  resolveOrg,
  setCredential,
  VaultError,
} from "@armada/core/server";
import { validateAzureModelAccount } from "./azure-model-account.ts";
import { scopedOrg } from "./control-caller.ts";
import { optional, required, requiredNumber, UUID } from "./control-input.ts";
import { listControlCredentials } from "./credential-list.ts";
import { modelAuthCapabilities } from "./model-auth.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";

function scope(body: Record<string, unknown>): "user" | "org" {
  const value = required(body, "scope");
  if (value === "user" || value === "org") return value;
  throw new VaultError("invalid", "scope is user or org.");
}

async function mutateAccount({ route, caller, body, options }: ControlRouteContext) {
  const { store, encryptionKey } = options;
  const { userId } = caller;
  const org = scopedOrg(caller, optional(body, "org"));
  const action = route.split("/").at(-1) as "set" | "rename" | "default" | "remove" | "limits";
  const account = await mutateCredentialAccount(
    store,
    encryptionKey,
    userId,
    {
      action,
      ...(body.model !== undefined ? { model: required(body, "model") } : {}),
      ...(body.maxAgents === undefined
        ? {}
        : { maxAgents: body.maxAgents === null ? null : requiredNumber(body, "maxAgents") }),
      ...(body.expectedVersion === undefined ? {} : { expectedVersion: requiredNumber(body, "expectedVersion") }),
      ...(optional(body, "expiresAt") ? { expiresAt: required(body, "expiresAt") } : {}),
      scope: scope(body),
      ...(org ? { org } : {}),
      ...(body.id !== undefined ? { id: required(body, "id") } : {}),
      ...(body.name !== undefined ? { name: required(body, "name") } : {}),
      ...(optional(body, "kind") ? { kind: parseCredentialKind(required(body, "kind")) } : {}),
      ...(optional(body, "value") ? { value: required(body, "value") } : {}),
    },
    options.modelAccountValidator ?? validateAzureModelAccount,
  );
  return { account };
}

export const credentialRoutes = defineRoutes("credential-control", {
  "creds/defaults/set": async ({ caller, body, options }) => {
    const { store } = options;
    const { userId } = caller;
    const org = scopedOrg(caller, optional(body, "org"));
    const harness = required(body, "harness");
    if (harness !== "claude" && harness !== "codex" && harness !== "opencode")
      throw new VaultError("invalid", "Unknown agent.");
    const credentialId = body.credentialId === null ? null : required(body, "credentialId");
    const model = body.model === null ? null : required(body, "model");
    if (
      (credentialId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(credentialId)) ||
      (model && (!model.trim() || model.length > 256 || /\s/.test(model)))
    )
      throw new VaultError("invalid", "Invalid agent default.");
    if (model) resolveModelChoice(harness, { model });
    if (!store.setAgentDefault) throw new VaultError("unavailable", "Agent defaults unavailable.");
    const member = org ? await resolveOrg(store, userId, org) : undefined;
    await store.setAgentDefault(userId, { harness, credentialId, model }, member?.id);
    return { ok: true };
  },
  "creds/accounts/limits": mutateAccount,
  "creds/accounts/set": mutateAccount,
  "creds/accounts/rename": mutateAccount,
  "creds/accounts/default": mutateAccount,
  "creds/accounts/remove": mutateAccount,
  "creds/set": async ({ caller, body, options }) => {
    const { store, encryptionKey } = options;
    const { userId } = caller;
    const org = scopedOrg(caller, optional(body, "org"));
    await setCredential(
      store,
      encryptionKey,
      userId,
      {
        scope: scope(body),
        org,
        kind: parseCredentialKind(required(body, "kind")),
        value: required(body, "value"),
      },
      options.modelAccountValidator ?? validateAzureModelAccount,
    );
    return { ok: true };
  },
  "creds/list": ({ caller, body, options }) => {
    const { store } = options;
    const { userId } = caller;
    const org = scopedOrg(caller, optional(body, "org"));
    return options.listCredentialMetadata
      ? options.listCredentialMetadata(userId, org)
      : listControlCredentials(store, userId, org);
  },
  "creds/accounts/models": async ({ caller, body, options }) => {
    const { store, encryptionKey } = options;
    const { userId } = caller;
    const org = scopedOrg(caller, optional(body, "org"));
    // The declared models of visible custom connections (#1483): decrypted here, never the key or the address.
    const member = await resolveOrg(store, userId, org);
    return { connections: await listConnectionModels(store, encryptionKey, { userId, orgId: member.id }) };
  },
  "creds/rm": async ({ caller, body, options }) => {
    const { store } = options;
    const { userId } = caller;
    const org = scopedOrg(caller, optional(body, "org"));
    await removeCredential(store, userId, {
      scope: scope(body),
      org,
      kind: parseCredentialKind(required(body, "kind")),
    });
    return { ok: true };
  },
  "creds/accounts/auth-capabilities": ({ options }) => ({
    ...modelAuthCapabilities,
    nativeSubscriptionParallelSandboxes: Boolean(options.modelAuth?.broker),
  }),
  "creds/accounts/usage": ({ caller, body, options }) => {
    if (!options.modelUsage || !options.logs) throw new VaultError("unavailable", "Model usage is not configured.");
    const id = required(body, "id"),
      sandboxId = optional(body, "sandboxId");
    if (!UUID.test(id) || (sandboxId !== undefined && !UUID.test(sandboxId)))
      throw new VaultError("invalid", "Account and sandbox IDs must be UUIDs.");
    const logs = options.logs;
    return options.modelUsage.read(caller, id, sandboxId, (boundSandbox) => logs(caller, boundSandbox));
  },
});
