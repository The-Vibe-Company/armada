export { sandboxActivity } from "@armada/core/server";

/** Guard bigint fences before converting them to numbers or reserving an advance. */
export function requireGenerationHeadroom(value: string | number, advances: number): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > Number.MAX_SAFE_INTEGER - advances)
    throw new Error("Sandbox lifecycle generation cannot be advanced safely.");
  return generation;
}

/** Keep existing history identity; append a newly observed conversation without reordering prior turns. */
export const appendConversation = (ids: string[], id: string) => (ids.includes(id) ? ids : [...ids, id]);
