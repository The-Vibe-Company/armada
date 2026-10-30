import { z } from "zod";
import { identifier, requestSchema, versionSchema as version } from "./envelope.js";

/** First wire minor with the shared Armada web account. */
export const ACCOUNT_MINOR = 8;
const request = { version, id: identifier };
// The app reads account replies; leave request validators out of its bundle.
export const accountStatusRequestSchema = /* @__PURE__ */ requestSchema("account.status", {});
export const accountLoginRequestSchema = /* @__PURE__ */ requestSchema("account.login", {});
export const accountLogoutRequestSchema = /* @__PURE__ */ requestSchema("account.logout", {});
const signedOut = { signedIn: z.literal(false), apiUrl: identifier };
const signedIn = {
  signedIn: z.literal(true),
  apiUrl: identifier,
  email: identifier,
  organization: z.object({ name: identifier, slug: identifier }),
  projects: z.array(z.object({ slug: identifier, name: identifier })),
  keys: z.object({ linear: z.boolean(), github: z.boolean() }),
};
export type AccountState = z.infer<z.ZodObject<typeof signedOut>> | z.infer<z.ZodObject<typeof signedIn>>;
/** The same result is pushed without an id when the account changes. */
const result = { version, id: identifier.optional(), type: z.literal("account.result") };
export const accountResultSchema = z.discriminatedUnion("signedIn", [
  z.object({ ...result, ...signedOut }),
  z.object({ ...result, ...signedIn }),
]);
export const accountDeviceSchema = z.object({
  ...request,
  type: z.literal("account.device"),
  code: identifier,
  verificationUrl: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type AccountRequest =
  | z.infer<typeof accountStatusRequestSchema>
  | z.infer<typeof accountLoginRequestSchema>
  | z.infer<typeof accountLogoutRequestSchema>;
export type AccountDevice = z.infer<typeof accountDeviceSchema>;
export type AccountResult = z.infer<typeof accountResultSchema>;
