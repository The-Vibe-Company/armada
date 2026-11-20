import { z } from "zod";
import { VaultError } from "./vault-error.ts";

// Allow opaque provider credentials without accepting whitespace, control characters, or malformed Unicode.
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
      expiry: z.iso.datetime({ offset: true }).max(64).optional(),
    }),
  }),
  z.strictObject({
    method: z.literal("gemini-api-key"),
    apiKey: secret,
  }),
]);

export type AntigravityCredential = z.infer<typeof credential>;

/** Validate the credential value shared by the vault and the runtime. Errors never include the input. */
export function parseAntigravityCredential(value: unknown): AntigravityCredential {
  const result = credential.safeParse(value);
  if (!result.success) {
    throw new VaultError("invalid", "Invalid Antigravity credential. Supply a Google token pair or a Gemini API key.");
  }
  return result.data;
}
