import { refusal } from "./errors.ts";
import type { ModalManagementProvenance, Scope } from "./ports.ts";

/** Source access remains private even when its management credential came from the org fallback.
 * Only trusted server-selected provenance is accepted; never derive ownership from a profile label. */
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
  // Legacy records predate this metadata. Root supplies their trusted persisted connection context;
  // new resources and snapshots always retain explicit provenance for subsequent matching.
  return (
    !recorded ||
    (recorded.credentialScope === chosen.credentialScope && recorded.credentialOwnerId === chosen.credentialOwnerId)
  );
}
