import { listCredentials, type VaultStore } from "@armada/core/server";

type KeyPresence = { ok: true; value: boolean } | { ok: false; error: unknown };

/** Keep core's membership/response policy; overlap independent metadata reads only after org resolution. */
export function listControlCredentials(store: VaultStore, userId: string, org: string | undefined) {
  const keys = new Map<string, Promise<KeyPresence>>();
  return listCredentials(
    {
      ...store,
      memberships: (id) => store.memberships(id),
      listCredentials: (scope, ownerId) => {
        if (scope === "org") {
          // Convert rejection into data until core asks for it. If the credential read fails first,
          // an unused parallel key check must not become an unhandled rejection.
          keys.set(
            ownerId,
            Promise.resolve()
              .then(() => store.hasOrgBoatKey(ownerId))
              .then(
                (value) => ({ ok: true, value }) as const,
                (error) => ({ ok: false, error }) as const,
              ),
          );
        }
        return store.listCredentials(scope, ownerId);
      },
      hasOrgBoatKey: async (id) => {
        const pending = keys.get(id);
        if (!pending) return store.hasOrgBoatKey(id);
        const result = await pending;
        if (!result.ok) throw result.error;
        return result.value;
      },
    },
    userId,
    org,
  );
}
