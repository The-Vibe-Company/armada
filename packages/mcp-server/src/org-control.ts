import { controlRouteKey, memberOperations } from "@armada/core/contract";
import {
  addMember,
  createOrg,
  listMembers,
  listOrgs,
  removeMember,
  setMemberRole,
  VaultError,
} from "@armada/core/server";
import type { z } from "zod";
import { scopedOrg } from "./control-caller.ts";
import { optional, required } from "./control-input.ts";
import { connectOrgProvider, disconnectOrgProvider, orgProviderStatus, validateOrgProvider } from "./org-provider.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";

function parseMemberInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new VaultError("invalid", parsed.error.issues[0]?.message ?? "Invalid membership request.");
  return parsed.data;
}

function memberRoute<T extends z.ZodType & { shape: { org: z.ZodType<string | null | undefined> } }>(
  operation: { route: { method: "POST" }; input: { body: T } },
  handle: (context: ControlRouteContext, input: Omit<z.output<T>, "org"> & { org: string | undefined }) => unknown,
) {
  const schema = operation.input.body;
  return {
    methods: [operation.route.method],
    handler: (context: ControlRouteContext) => {
      const org = scopedOrg(context.caller, parseMemberInput(schema.shape.org, context.body.org) ?? undefined);
      return handle(context, { ...parseMemberInput(schema, context.body), org });
    },
  };
}

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
  [controlRouteKey(memberOperations.listMembers.route)]: memberRoute(
    memberOperations.listMembers,
    ({ caller, options }, { org }) => listMembers(options.store, caller.userId, org),
  ),
  [controlRouteKey(memberOperations.addMember.route)]: memberRoute(
    memberOperations.addMember,
    async ({ caller, options }, { org, email, role }) => ({
      member: await addMember(options.store, caller.userId, { org, email, role: role ?? "member" }),
    }),
  ),
  [controlRouteKey(memberOperations.setMemberRole.route)]: memberRoute(
    memberOperations.setMemberRole,
    async ({ caller, options }, input) => {
      await setMemberRole(options.store, caller.userId, input);
      return { ok: true };
    },
  ),
  [controlRouteKey(memberOperations.removeMember.route)]: memberRoute(
    memberOperations.removeMember,
    async ({ caller, options }, input) => {
      await removeMember(options.store, caller.userId, input);
      return { ok: true };
    },
  ),
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
