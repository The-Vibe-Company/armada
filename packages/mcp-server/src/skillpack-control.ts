import { controlRouteKey, skillpackOperations, skillpackVersionInputs } from "@armada/core/contract";
import {
  createSkillCatalog,
  listCredentials,
  resolveOrg,
  resolveSkillpackCredential,
  VaultError,
} from "@armada/core/server";
import type { z } from "zod";
import { readVaultControlBody } from "./control-body.ts";
import { scopedOrg } from "./control-caller.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";

const {
  listSkillpackCatalog: list,
  listSkillpackVersions: versions,
  readSkillpackConnection: connection,
} = skillpackOperations;

function parse<T extends z.ZodType>(schema: T, value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new VaultError("invalid", result.error.issues[0]?.message ?? "Invalid skill catalog request.");
  const data: z.output<T> = result.data;
  return data;
}

function catalogRoute(operation: typeof list | typeof versions) {
  const { shape: listFields } = list.input.body;
  const fields = operation === list ? listFields : skillpackVersionInputs.public.shape;
  return {
    methods: [operation.route.method],
    readBody: (request: Request) => readVaultControlBody(request, operation.input.maxBodyBytes),
    handler: async ({ caller, body, options }: ControlRouteContext) => {
      const { store, encryptionKey } = options;
      const { userId } = caller;
      const org = scopedOrg(caller, parse(fields.org, body.org) ?? undefined);
      if (Object.keys(body).some((key) => !Object.hasOwn(fields, key)))
        throw new VaultError("invalid", "Invalid skill catalog request.");
      const source = parse(listFields.source, body.source);
      const offset = "offset" in fields ? parse(fields.offset, body.offset) : undefined;
      const member = await resolveOrg(store, userId, org);
      const credential =
        source === "private"
          ? await resolveSkillpackCredential(store, encryptionKey, { userId, orgId: member.id })
          : null;
      const catalog = options.skillCatalog ?? createSkillCatalog();
      const result =
        "reference" in fields
          ? await catalog.versions(
              { source, reference: parse(skillpackVersionInputs[source].shape.reference, body.reference) },
              credential?.key,
            )
          : await catalog.list({ source, ...(offset === undefined ? {} : { offset }) }, credential?.key);
      await resolveOrg(store, userId, member.id);
      return result;
    },
  };
}

export const skillpackRoutes = defineRoutes("skillpack-control", {
  [controlRouteKey(list.route)]: catalogRoute(list),
  [controlRouteKey(versions.route)]: catalogRoute(versions),
  [controlRouteKey(connection.route)]: {
    methods: [connection.route.method],
    handler: async ({ caller, body, options }) => {
      const { store } = options;
      const { userId } = caller;
      const { org: requestedOrg } = parse(connection.input.body, body);
      const org = scopedOrg(caller, requestedOrg ?? undefined);
      const credentials = await listCredentials(store, userId, org);
      return {
        authorization: { available: false, reason: "delegated_key_flow_unavailable" },
        user: credentials.user.filter((credential) => credential.kind === "skillpack"),
        orgs: credentials.orgs.map((entry) => ({
          ...entry,
          credentials: entry.credentials.filter((credential) => credential.kind === "skillpack"),
        })),
      };
    },
  },
});
