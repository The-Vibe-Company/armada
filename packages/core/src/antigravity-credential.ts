import { z } from "zod";
import { VaultError } from "./vault-error.ts";

const secret = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[^\s\p{Cc}\p{Cs}]+$/u);

const credential = z.discriminatedUnion("method", [
  z.strictObject({
    method: z.literal("google"),
    token: z.strictObject({
      access_token: secret,
      refresh_token: secret,
      token_type: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[^\s\p{Cc}\p{Cs}]+$/u)
        .optional(),
      expires_in: z.number().int().nonnegative().optional(),
      expiry: z.iso.datetime({ offset: true }).max(64).optional(),
    }),
  }),
  z.strictObject({
    method: z.literal("gemini-api-key"),
    apiKey: secret,
  }),
]);

export type AntigravityCredential = z.infer<typeof credential>;

export function parseAntigravityCredential(value: unknown) {
  const result = credential.safeParse(value);
  if (!result.success) {
    throw new VaultError("invalid", "Invalid Antigravity credential. Supply a Google token pair or a Gemini API key.");
  }
  return result.data;
}

export function parseAntigravityValue(raw: string) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  return parseAntigravityCredential(value);
}

export function antigravitySecrets(value: AntigravityCredential) {
  return value.method === "google" ? [value.token.access_token, value.token.refresh_token] : [value.apiKey];
}
