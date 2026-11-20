import { controlRouteKey, memberOperations, organizationOperations } from "@armada/core/contract";
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
import { connectOrgProvider, disconnectOrgProvider, orgProviderStatus, validateOrgProvider } from "./org-provider.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";

function parseOrgInput<T extends z.ZodType>(schema: T, value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new VaultError("invalid", parsed.error.issues[0]?.message ?? "Invalid organization request.");
  const data: z.output<T> = parsed.data;
  return data;
}

function orgScopedRoute<T extends z.ZodType & { shape: { org: z.ZodType<string | null | undefined> } }>(
  operation: { route: { method: "POST" }; input: { body: T } },
  handle: (context: ControlRouteContext, org: string | undefined, input: z.output<T>) => unknown,
) {
  const schema = operation.input.body;
  return {
    methods: [operation.route.method],
    handler: (context: ControlRouteContext) => {
      const org = scopedOrg(context.caller, parseOrgInput(schema.shape.org, context.body.org) ?? undefined);
      return handle(context, org, parseOrgInput(schema, context.body));
    },
  };
}

function orgProviderRoute<T extends z.ZodType>(
  operation: { route: { method: "POST" }; input: { body: T } },
  handle: (context: ControlRouteContext, input: z.output<T>) => unknown,
) {
  return {
    methods: [operation.route.method],
    handler: (context: ControlRouteContext) => handle(context, parseOrgInput(operation.input.body, context.body)),
  };
}

export const orgRoutes = defineRoutes("org-control", {
  [controlRouteKey(organizationOperations.createOrganization.route)]: orgScopedRoute(
    organizationOperations.createOrganization,
    async ({ caller, options }, _org, { name }) => ({
      org: await createOrg(options.store, caller.userId, name),
    }),
  ),
  [controlRouteKey(organizationOperations.listOrganizations.route)]: orgScopedRoute(
    organizationOperations.listOrganizations,
    async ({ caller, options }) => ({
      orgs: (await listOrgs(options.store, caller.userId)).filter(
        (item) => caller.via === "supabase" || caller.orgs.some((scope) => scope.orgId === item.id),
      ),
    }),
  ),
  [controlRouteKey(memberOperations.listMembers.route)]: orgScopedRoute(
    memberOperations.listMembers,
    ({ caller, options }, org) => listMembers(options.store, caller.userId, org),
  ),
  [controlRouteKey(memberOperations.addMember.route)]: orgScopedRoute(
    memberOperations.addMember,
    async ({ caller, options }, org, { email, role }) => ({
      member: await addMember(options.store, caller.userId, { org, email, role: role ?? "member" }),
    }),
  ),
  [controlRouteKey(memberOperations.setMemberRole.route)]: orgScopedRoute(
    memberOperations.setMemberRole,
    async ({ caller, options }, org, { email, role }) => {
      await setMemberRole(options.store, caller.userId, { org, email, role });
      return { ok: true };
    },
  ),
  [controlRouteKey(memberOperations.removeMember.route)]: orgScopedRoute(
    memberOperations.removeMember,
    async ({ caller, options }, org, { email }) => {
      await removeMember(options.store, caller.userId, { org, email });
      return { ok: true };
    },
  ),
  [controlRouteKey(organizationOperations.readOrganizationProviderStatus.route)]: orgProviderRoute(
    organizationOperations.readOrganizationProviderStatus,
    ({ caller, options }, { org }) => orgProviderStatus(options.store, caller, org ?? undefined),
  ),
  [controlRouteKey(organizationOperations.connectOrganizationProvider.route)]: orgProviderRoute(
    organizationOperations.connectOrganizationProvider,
    ({ caller, options }, { org, provider, value }) =>
      connectOrgProvider(
        options.store,
        options.encryptionKey,
        caller,
        org ?? undefined,
        provider,
        value,
        options.providerValidator ?? validateOrgProvider,
      ),
  ),
  [controlRouteKey(organizationOperations.disconnectOrganizationProvider.route)]: orgProviderRoute(
    organizationOperations.disconnectOrganizationProvider,
    ({ caller, options }, { org, provider }) =>
      disconnectOrgProvider(options.store, caller, org ?? undefined, provider),
  ),
});
