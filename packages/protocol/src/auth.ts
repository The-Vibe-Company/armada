import { z } from "zod";

/** Shared interactive authentication transport (minor 9). A flow belongs to one connection. */
export const AUTH_MINOR = 9;
const id = z.string().min(1).max(200);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const envelope = { version: z.object({ major: counter, minor: counter }), id };
const browserUrl = z.url().regex(/^https?:\/\//i);
const link = z.object({ url: browserUrl, label: z.string().optional() });
export const authEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth_url"), url: browserUrl, instructions: z.string().optional() }),
  z.object({
    type: z.literal("device_code"),
    userCode: z.string(),
    verificationUri: browserUrl,
    intervalSeconds: z.number().nonnegative().optional(),
    expiresInSeconds: z.number().nonnegative().optional(),
  }),
  z.object({ type: z.literal("progress"), message: z.string() }),
  z.object({ type: z.literal("info"), message: z.string(), links: z.array(link).optional() }),
  z.object({ type: z.literal("terminal"), output: z.string() }),
]);
export const authEventMessageSchema = z.object({
  version: envelope.version,
  type: z.literal("auth.event"),
  flow: id,
  event: authEventSchema,
});
export const authPromptSchema = z.object({
  ...envelope,
  type: z.literal("auth.prompt"),
  flow: id,
  promptType: z.enum(["text", "secret", "select", "manual_code"]),
  message: z.string(),
  placeholder: z.string().optional(),
  options: z.array(z.object({ id, label: z.string(), description: z.string().optional() })).optional(),
});
export const authAnswerSchema = z.object({
  ...envelope,
  type: z.literal("auth.answer"),
  flow: id,
  value: z.string().max(16384),
});
export const authCancelSchema = z.object({ ...envelope, type: z.literal("auth.cancel"), flow: id });
export const authRequestSchemas = [authAnswerSchema, authCancelSchema] as const;
export const authResultSchemas = [authEventMessageSchema, authPromptSchema] as const;
export type AuthEvent = z.infer<typeof authEventSchema>;
export type AuthFrame = z.infer<typeof authEventMessageSchema> | z.infer<typeof authPromptSchema>;
