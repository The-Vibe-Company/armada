import {
  addMember,
  createOrg,
  listMembers,
  listOrgs,
  parseRole,
  removeMember,
  setMemberRole,
} from "@armada/core/server";
import { scopedOrg } from "./control-caller.ts";
import { optional, required } from "./control-input.ts";
import { connectOrgProvider, disconnectOrgProvider, orgProviderStatus, validateOrgProvider } from "./org-provider.ts";
import { defineRoutes } from "./routes.ts";

export const orgRoutes = defineRoutes("org-control", {
  "org/create": async ({ caller, body, options }) => {
    const { store } = options;
    const { userId } = caller;
    scopedOrg(caller, optional(body, "org"));
    return { org: await createOrg(store, userId, required(body, "name")) };
  },
  "org/list": async ({ caller, body, options }) => {
    const { store } = options;
    const { userId } = caller;
    scopedOrg(caller, optional(body, "org"));
    return {
      orgs: (await listOrgs(store, userId)).filter(
        (item) => caller.via === "supabase" || caller.orgs.some((scope) => scope.orgId === item.id),
      ),
    };
  },
  "members/list": ({ caller, body, options }) => {
    const { store } = options;
    const { userId } = caller;
    const org = scopedOrg(caller, optional(body, "org"));
    return listMembers(store, userId, org);
  },
  "members/add": async ({ caller, body, options }) => {
    const { store } = options;
    const { userId } = caller;
    const org = scopedOrg(caller, optional(body, "org"));
    return {
      member: await addMember(store, userId, {
        org,
        email: required(body, "email"),
        role: parseRole(optional(body, "role") ?? "member"),
      }),
    };
  },
  "members/role": async ({ caller, body, options }) => {
    const { store } = options;
    const { userId } = caller;
    const org = scopedOrg(caller, optional(body, "org"));
    await setMemberRole(store, userId, {
      org,
      email: required(body, "email"),
      role: parseRole(required(body, "role")),
    });
    return { ok: true };
  },
  "members/remove": async ({ caller, body, options }) => {
    const { store } = options;
    const { userId } = caller;
    const org = scopedOrg(caller, optional(body, "org"));
    await removeMember(store, userId, { org, email: required(body, "email") });
    return { ok: true };
  },
  "org/provider/status": ({ caller, body, options }) => orgProviderStatus(options.store, caller, optional(body, "org")),
  "org/provider/connect": ({ caller, body, options }) =>
    connectOrgProvider(
      options.store,
      options.encryptionKey,
      caller,
      optional(body, "org"),
      required(body, "provider"),
      required(body, "value"),
      options.providerValidator ?? validateOrgProvider,
    ),
  "org/provider/disconnect": ({ caller, body, options }) =>
    disconnectOrgProvider(options.store, caller, optional(body, "org"), required(body, "provider")),
});
