export { sandboxActivity } from "@armada/core/server";

/** Keep existing history identity; append a newly observed conversation without reordering prior turns. */
export const appendConversation = (ids: string[], id: string) => (ids.includes(id) ? ids : [...ids, id]);
