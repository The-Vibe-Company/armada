import { z } from "zod";
import type { Operation } from "./index.ts";

export const signInMethod = z.enum(["email", "github", "google"]);
const browserProvider = z.enum(["github", "google"]);
const pkce = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
const loopback = z
  .string()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const callback = new URL(value);
    return (
      callback.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(callback.hostname) &&
      !!callback.port &&
      !callback.username &&
      !callback.password &&
      !callback.hash
    );
  })
  .meta({
    format: "uri",
    description:
      "HTTP localhost or 127.0.0.1 callback with an explicit non-default port, no credentials, and no fragment.",
  });
const callbackFields = {
  redirect_uri: loopback,
  code_challenge: pkce,
  state: z.string().regex(/^[A-Za-z0-9._~-]{8,512}$/),
};
const email = z.string().describe("Email address, at most 254 characters after trimming surrounding whitespace.");
const session = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.iso.datetime(),
});

const anonymous = {
  anonymous: true,
  audience: "public",
  destructive: false,
  successHeaders: { "Cache-Control": z.literal("no-store") },
} as const;

export const publicAuthOperations = {
  authMethods: {
    ...anonymous,
    name: "authMethods",
    route: { method: "GET", path: "/api/v1/auth/methods" },
    input: { body: z.undefined() },
    output: z.object({ methods: z.array(signInMethod) }),
    readOnly: true,
    description: "List the sign-in methods enabled on this server.",
    errors: ["unavailable"],
  },
  authAuthorize: {
    ...anonymous,
    name: "authAuthorize",
    route: { method: "GET", path: "/api/v1/auth/authorize" },
    input: { body: z.undefined(), query: z.object({ provider: browserProvider, ...callbackFields }) },
    output: undefined,
    successStatus: 302,
    successHeaders: { ...anonymous.successHeaders, Location: z.url() },
    readOnly: true,
    description: "Redirect the browser to the selected OAuth provider through the sign-in service.",
    errors: ["invalid"],
  },
  authExchange: {
    ...anonymous,
    name: "authExchange",
    route: { method: "POST", path: "/api/v1/auth/exchange" },
    input: { body: z.object({ code: z.string().max(4096), verifier: pkce }) },
    output: session,
    readOnly: false,
    description: "Exchange an authorization code and its PKCE verifier for a session.",
    errors: ["invalid", "usage", "unauthorized", "unavailable"],
  },
  authEmailStart: {
    ...anonymous,
    name: "authEmailStart",
    route: { method: "POST", path: "/api/v1/auth/email/start" },
    input: {
      body: z
        .object({
          email,
          ...callbackFields,
          cli_email_link: z
            .boolean()
            .optional()
            .describe("When true, redirect_uri must use the /callback path with no query."),
        })
        .refine(({ cli_email_link, redirect_uri }) => {
          if (!cli_email_link || !URL.canParse(redirect_uri)) return !cli_email_link;
          const url = new URL(redirect_uri);
          return url.pathname === "/callback" && !url.search;
        }),
    },
    output: z.object({ ok: z.literal(true) }),
    readOnly: false,
    description: "Start email sign-in using a verification code or an opted-in CLI loopback link.",
    errors: ["invalid", "usage", "unauthorized", "rate_limited", "unavailable"],
  },
  authEmailVerify: {
    ...anonymous,
    name: "authEmailVerify",
    route: { method: "POST", path: "/api/v1/auth/email/verify" },
    input: {
      body: z.object({
        email,
        code: z.string().describe("The 6 to 10 digits from the email. Whitespace is ignored."),
      }),
    },
    output: session,
    readOnly: false,
    description: "Verify an email sign-in code and return the session.",
    errors: ["invalid", "usage", "unauthorized", "unavailable"],
  },
  authRefresh: {
    ...anonymous,
    name: "authRefresh",
    route: { method: "POST", path: "/api/v1/auth/refresh" },
    input: { body: z.object({ refreshToken: z.string() }) },
    output: session,
    readOnly: false,
    description: "Renew a session using its refresh token.",
    errors: ["invalid", "usage", "unauthorized", "unavailable"],
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType | undefined>>;

const githubCallback = { "github/oauth/callback": ["GET", "POST"] } as const;

export const PUBLIC_CONTROL_ROUTES: typeof githubCallback & Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(
    Object.values(publicAuthOperations).map(({ route }) => [route.path.slice("/api/v1/".length), [route.method]]),
  ),
  ...githubCallback,
};
