import { refusal } from "./errors.ts";
import type { ModalManagementProvenance, Scope } from "./ports.ts";

export function chooseManagementAuthority(
  source: Scope,
  requested?: ModalManagementProvenance,
): ModalManagementProvenance {
  const { credentialScope, credentialOwnerId } = requested ?? {
    credentialScope: source.visibility === "org" ? "org" : "user",
    credentialOwnerId: source.visibility === "org" ? source.orgId : source.userId,
  };
  const chosen = { credentialScope, credentialOwnerId };
  const org = chosen.credentialScope === "org" && chosen.credentialOwnerId === source.orgId;
  const own =
    source.visibility === "private" && chosen.credentialScope === "user" && chosen.credentialOwnerId === source.userId;
  if (!org && !own)
    throw refusal("forbidden", "Management authority must be the source org or the private source owner's own key.");
  return Object.freeze({ credentialScope: chosen.credentialScope, credentialOwnerId: chosen.credentialOwnerId });
}
export function matchesManagementAuthority(
  recorded: ModalManagementProvenance | undefined,
  chosen: ModalManagementProvenance,
): boolean {
  return (
    !recorded ||
    (recorded.credentialScope === chosen.credentialScope && recorded.credentialOwnerId === chosen.credentialOwnerId)
  );
}
