import { z } from "zod";

/** Lowercase only: the Docker send handler keys its durable queue and runtime commands on this exact text. */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const DOCKER_PROMPT_MAX_BYTES = 262144;

/**
 * A Docker prompt, wherever Docker admits one (first prompt at launch, later sends): not
 * blank (`\S` matches exactly what `String.prototype.trim` keeps) and at most 256 KiB of
 * UTF-8. Admission and the published schemas both use this value.
 */
export const DOCKER_PROMPT = z
  .string()
  .regex(/\S/)
  .max(DOCKER_PROMPT_MAX_BYTES)
  .refine((prompt) => Buffer.byteLength(prompt) <= DOCKER_PROMPT_MAX_BYTES);

/**
 * The `sandbox/send` fields Docker send admission validates, on top of the shared send tool
 * input. It is the single source for the account queue's check and for the published Docker
 * variant. Other keys (the sandbox `id`, `org`) are routing. The account queue applies it to
 * the normalized request, after generating a request_id for a send that omits one: clients
 * released before this contract (earlier iOS builds) send no key and must keep working.
 */
export const DOCKER_SEND_REQUEST = z
  .object({
    prompt: DOCKER_PROMPT.describe("The instruction: not blank, at most 256 KiB of UTF-8."),
    request_id: uuid
      .optional()
      .describe(
        "A lowercase UUID. The prompt is queued durably under it: retry uncertain delivery with the same request_id and identical input, and use a new one for a new turn. Required to replay safely: when omitted, the server generates one (the receipt's requestId) and a retry without it queues the prompt again.",
      ),
    conversation_id: uuid
      .optional()
      .describe("The sandbox's current conversation UUID, in lowercase. Omit to target it automatically."),
    model: z.never().optional().describe("Refused: a Docker sandbox keeps the model chosen at launch."),
    reasoning_effort: z.never().optional().describe("Refused: a Docker sandbox keeps the effort chosen at launch."),
  })
  .describe(
    "Docker admission rules: model and reasoning_effort are refused because they remain pinned to launch; a caller-supplied request_id is what makes a retry replay instead of queuing again.",
  );

/** Docker dispatch (`docker-normal-send.ts`) always receives a key: the caller's or the account queue's. */
export const DOCKER_DISPATCH_REQUEST = DOCKER_SEND_REQUEST.extend({ request_id: uuid });

/** Public guidance for a send that Docker admission refuses, wherever it is admitted. */
export const DOCKER_SEND_REFUSAL =
  "Docker send requires a non-blank prompt of at most 256 KiB and, when given, a lowercase UUID request_id; model and reasoning_effort are refused because they stay pinned to launch.";
