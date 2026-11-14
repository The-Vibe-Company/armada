import { listCredentials, type VaultStore } from "@armada/core/server";

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Keep core's response policy: own metadata needs only user identity; org reads wait for membership. */
export function listControlCredentials(store: VaultStore, userId: string, org: string | undefined) {
  const keys = new Map<string, Promise<Outcome<boolean>>>();
  // Called only after bearer verification. This reads the authenticated user's own metadata,
  // never another user's credentials. Settle errors until core reaches its original user-read stage.
  const userMetadata = Promise.resolve()
    .then(() => store.listCredentials("user", userId))
    .then(
      (value) => ({ ok: true, value }) as const,
      (error) => ({ ok: false, error }) as const,
    );
  return listCredentials(
    {
      ...store,
      memberships: (id) => store.memberships(id),
      listCredentials: (scope, ownerId) => {
        if (scope === "user" && ownerId === userId)
          return userMetadata.then((result) => {
            if (!result.ok) throw result.error;
            return result.value;
          });
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
