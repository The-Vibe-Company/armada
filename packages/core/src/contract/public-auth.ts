import { z } from "zod";
import type { Operation } from "./index.ts";

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
  authDeviceStart: {
    ...anonymous,
    name: "authDeviceStart",
    route: { method: "POST", path: "/api/v1/auth/device/start" },
    input: { body: z.object({ hostname: z.string().regex(/^[a-zA-Z0-9_.-]{1,253}$/) }) },
    output: z.object({
      device_code: z.string().regex(/^[a-f0-9]{64}$/),
      user_code: z.string().regex(/^[A-F0-9]{8}$/),
      verification_uri_complete: z.url(),
      expires_in: z.number().int().min(1).max(600),
      interval: z.number().int().min(1).max(600),
    }),
    readOnly: false,
    description: "Start a CLI device login request.",
    errors: ["invalid", "rate_limited", "unavailable"],
  },
  authDeviceInspect: {
    audience: "public",
    destructive: false,
    directServer: true,
    successHeaders: anonymous.successHeaders,
    name: "authDeviceInspect",
    route: { method: "POST", path: "/api/v1/auth/device/inspect" },
    input: { body: z.object({ id: z.uuid() }) },
    output: z.object({ user_code: z.string(), hostname: z.string() }),
    readOnly: true,
    description: "Read a pending CLI login request using a signed-in dashboard session.",
    errors: ["invalid", "unauthorized", "not_found", "unavailable"],
  },
  authDeviceDecide: {
    audience: "public",
    destructive: false,
    directServer: true,
    successHeaders: anonymous.successHeaders,
    name: "authDeviceDecide",
    route: { method: "POST", path: "/api/v1/auth/device/decide" },
    input: {
      body: z.object({
        id: z.uuid(),
        user_code: z.string().regex(/^[A-F0-9]{8}$/),
        approve: z.boolean(),
        issued_at: z.number().int(),
        proof: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    },
    output: z.object({ ok: z.literal(true) }),
    readOnly: false,
    description: "Authorize or deny a pending CLI login as the signed-in dashboard user.",
    errors: ["invalid", "unauthorized", "not_found", "unavailable"],
  },
  authDevicePoll: {
    ...anonymous,
    name: "authDevicePoll",
    route: { method: "POST", path: "/api/v1/auth/device/poll" },
    input: { body: z.object({ device_code: z.string().regex(/^[a-f0-9]{64}$/) }) },
    output: z.union([
      session.extend({ status: z.literal("authorized"), email: z.string().min(1) }),
      z.object({
        status: z.enum(["authorization_pending", "slow_down"]),
        interval: z.number().int().min(1).max(600),
      }),
      z.object({ status: z.enum(["access_denied", "expired_token"]) }),
    ]),
    readOnly: false,
    description: "Poll for a decision or redeem an approved request once.",
    errors: ["invalid", "unavailable"],
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
      body: z.strictObject({ email, ...callbackFields }),
    },
    output: z.object({ ok: z.literal(true) }),
    readOnly: false,
    description: "Start email sign-in using a verification code.",
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

const githubCallbackPath = "/api/v1/github/oauth/callback";
const githubCallbackInput = z.strictObject({
  state: z.string().regex(/^armada_cli_[0-9a-f-]{72}$/),
  code: z.string().regex(/^[!-~]{1,1024}$/),
});
const githubCallback = {
  ...anonymous,
  route: { path: githubCallbackPath },
  output: z.object({ ok: z.literal(true), status: z.literal("connected") }),
  errorOutput: z.object({ ok: z.literal(false), status: z.literal("failed") }),
  readOnly: false,
  errors: ["invalid", "dependency_unavailable"],
} as const;

export const githubCallbackOperations = {
  githubOAuthCallback: {
    ...githubCallback,
    name: "githubOAuthCallback",
    route: { ...githubCallback.route, method: "GET" },
    input: { body: z.undefined(), query: githubCallbackInput },
    description: "Complete the GitHub CLI OAuth flow using exactly one state and one code query parameter.",
  },
  githubOAuthRelay: {
    ...githubCallback,
    name: "githubOAuthRelay",
    route: { ...githubCallback.route, method: "POST" },
    input: { body: githubCallbackInput, maxBodyBytes: 8192, oversizedBodyStatus: 400 },
    description:
      "Complete the GitHub CLI OAuth flow using a JSON object with unique state and code keys. Direct server requests must omit the query string.",
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType | undefined>>;

export function deviceConsentMessage(
  {
    id,
    user_code,
    approve,
    issued_at,
  }: Omit<z.infer<typeof publicAuthOperations.authDeviceDecide.input.body>, "proof">,
  userId: string,
  authorization: string,
) {
  return JSON.stringify(["armada-cli-consent", id, user_code, approve, issued_at, userId, authorization]);
}

const publicMethods: Record<string, string[]> = Object.create(null);
for (const operation of Object.values({ ...publicAuthOperations, ...githubCallbackOperations })) {
  if (!("anonymous" in operation)) continue;
  const { route } = operation;
  const key = route.path.slice("/api/v1/".length);
  publicMethods[key] ??= [];
  publicMethods[key].push(route.method);
}
export const PUBLIC_CONTROL_ROUTES: Readonly<Record<string, readonly string[]>> = publicMethods;
