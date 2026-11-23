import type { SandboxRecord } from "@armada/core/server";
import type { ServerSandboxPatch, ServerSandboxStore } from "./data.ts";

export { sandboxActivity } from "@armada/core/server";

/** Keep existing history identity; append a newly observed conversation without reordering prior turns. */
export const appendConversation = (ids: string[], id: string) => (ids.includes(id) ? ids : [...ids, id]);

export async function admitModalStop(
  store: Pick<ServerSandboxStore, "update">,
  sandbox: Pick<SandboxRecord, "id" | "lifecycleGeneration">,
  patch: ServerSandboxPatch,
  childOperation?: string,
) {
  const generation = sandbox.lifecycleGeneration;
  if (
    generation === undefined ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation >= Number.MAX_SAFE_INTEGER
  )
    throw Error("Cannot fence Modal stop generation.");
  await store.update(sandbox.id, {
    ...patch,
    modalStopJob: childOperation ? { childOperation } : {},
    advanceGeneration: true,
    expectedGeneration: generation,
    activityToken: crypto.randomUUID(),
  });
}
