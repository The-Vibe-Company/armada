import { VaultError } from "@armada/core/server";

export const SINGLE_CONVERSATION_GUIDANCE =
  "A sandbox has one conversation. Launch another sandbox for a separate conversation.";

export function refuseConversationSelector(input: object) {
  if (Object.hasOwn(input, "conversation_id") || Object.hasOwn(input, "conversationId"))
    throw new VaultError("conflict", SINGLE_CONVERSATION_GUIDANCE);
}
