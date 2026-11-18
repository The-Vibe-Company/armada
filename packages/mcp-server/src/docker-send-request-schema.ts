import { z } from "zod";

/** Lowercase only: the Docker send handler keys its durable queue and runtime commands on this exact text. */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const DOCKER_PROMPT_MAX_BYTES = 262144;

/**
 * The `sandbox/send` fields Docker send admission (`docker-normal-send.ts`) validates,
 * on top of the shared send tool input. It is the single source for that check and
 * for the published Docker variant. Other keys (the sandbox `id`, `org`) are routing.
 */
export const DOCKER_SEND_REQUEST = z
  .object({
    prompt: z
      .string()
      .regex(/\S/)
      .max(DOCKER_PROMPT_MAX_BYTES)
      .refine((prompt) => Buffer.byteLength(prompt) <= DOCKER_PROMPT_MAX_BYTES)
      .describe("The instruction: not blank, at most 256 KiB of UTF-8."),
    request_id: uuid.describe(
      "Required lowercase UUID. The prompt is queued durably under it; retry uncertain delivery with the same request_id and identical input, and use a new one for a new turn.",
    ),
    conversation_id: uuid.optional().describe("A lowercase conversation UUID of the sandbox. Default: the latest."),
    model: z.never().optional().describe("Refused: a Docker sandbox keeps the model chosen at launch."),
    reasoning_effort: z.never().optional().describe("Refused: a Docker sandbox keeps the effort chosen at launch."),
  })
  .describe(
    "Docker admission rules: request_id is required, and model and reasoning_effort are refused because they remain pinned to launch.",
  );
