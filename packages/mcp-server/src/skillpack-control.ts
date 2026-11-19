import {
  createSkillCatalog,
  listCredentials,
  resolveOrg,
  resolveSkillpackCredential,
  VaultError,
} from "@armada/core/server";
import { scopedOrg } from "./control-caller.ts";
import { optional, required } from "./control-input.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";

async function readCatalog({ route, caller, body, options }: ControlRouteContext) {
  const { store, encryptionKey } = options;
  const { userId } = caller;
  const org = scopedOrg(caller, optional(body, "org"));
  const versions = route === "skillpack/versions";
  const allowed = versions ? ["org", "source", "reference"] : ["org", "source", "offset"];
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new VaultError("invalid", "Invalid skill catalog request.");
  if (body.source !== "public" && body.source !== "private")
    throw new VaultError("invalid", "Choose the public catalog or private workspace.");
  if (
    body.offset !== undefined &&
    (typeof body.offset !== "number" || !Number.isInteger(body.offset) || body.offset < 0 || body.offset > 10000)
  )
    throw new VaultError("invalid", "Invalid catalog offset.");
  const member = await resolveOrg(store, userId, org);
  // Resolve exactly the launching user's credential policy; never expose the
  // PAT or let a caller select an alternate registry or workspace header.
  const credential =
    body.source === "private"
      ? await resolveSkillpackCredential(store, encryptionKey, { userId, orgId: member.id })
      : null;
  const catalog = options.skillCatalog ?? createSkillCatalog();
  const result = versions
    ? await catalog.versions({ source: body.source, reference: required(body, "reference") }, credential?.key)
    : await catalog.list(
        { source: body.source, ...(body.offset === undefined ? {} : { offset: body.offset as number }) },
        credential?.key,
      );
  // Membership may have changed during the bounded upstream request.
  await resolveOrg(store, userId, member.id);
  return result;
}

export const skillpackRoutes = defineRoutes("skillpack-control", {
  "skillpack/catalog": readCatalog,
  "skillpack/versions": readCatalog,
  "skillpack/connection": async ({ caller, body, options }) => {
    const { store } = options;
    const { userId } = caller;
    const org = scopedOrg(caller, optional(body, "org"));
    // Reuse vault visibility, including live membership and token org scoping.
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
});
