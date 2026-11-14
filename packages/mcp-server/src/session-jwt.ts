import { type AuthFetch, assertSupabaseUrl } from "@armada/auth";
import { createRemoteJWKSet, customFetch, decodeProtectedHeader, errors, jwtVerify } from "jose";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Public signing keys only. Never cache an identity, token, session or membership decision.
const transports = new WeakMap<AuthFetch, Map<string, ReturnType<typeof createRemoteJWKSet>>>();
function keys(project: { supabaseUrl: string; fetch?: AuthFetch }) {
  const transport = project.fetch ?? fetch;
  let projects = transports.get(transport);
  if (!projects) {
    projects = new Map();
    transports.set(transport, projects);
  }
  const origin = assertSupabaseUrl(project.supabaseUrl);
  let resolver = projects.get(origin);
  if (!resolver) {
    // Configured origins, not bearer-controlled URLs. Bound retained caches even in multi-project hosts.
    if (projects.size >= 8) projects.delete(projects.keys().next().value!);
    resolver = createRemoteJWKSet(new URL("/auth/v1/.well-known/jwks.json", origin), {
      cacheMaxAge: 60_000,
      cooldownDuration: 5_000,
      timeoutDuration: 5_000,
      [customFetch]: (url, options) => transport(url, options),
    });
    projects.set(origin, resolver);
  }
  return resolver;
}

/** Undefined keeps legacy algorithms on Auth's existing path; null refuses an invalid ES256 bearer. */
export async function verifySessionJwt(
  token: string,
  project: { supabaseUrl: string; fetch?: AuthFetch },
  now: Date,
): Promise<{ userId: string; sessionId: string } | null | undefined> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    if (token.length > 16_384) return null;
    header = decodeProtectedHeader(token);
  } catch {
    return undefined;
  }
  if (header.alg !== "ES256") return undefined;
  if (typeof header.kid !== "string" || !header.kid || header.kid.length > 256) return null;
  try {
    const { payload } = await jwtVerify(token, keys(project), {
      algorithms: ["ES256"],
      issuer: `${assertSupabaseUrl(project.supabaseUrl)}/auth/v1`,
      audience: "authenticated",
      requiredClaims: ["sub", "exp", "iat", "session_id"],
      currentDate: now,
    });
    if (
      payload.role !== "authenticated" ||
      typeof payload.sub !== "string" ||
      !UUID.test(payload.sub) ||
      typeof payload.session_id !== "string" ||
      !UUID.test(payload.session_id)
    )
      return null;
    return { userId: payload.sub.toLowerCase(), sessionId: payload.session_id.toLowerCase() };
  } catch (error) {
    if (
      error instanceof errors.JWTExpired ||
      error instanceof errors.JWTClaimValidationFailed ||
      error instanceof errors.JWTInvalid ||
      error instanceof errors.JWSInvalid ||
      error instanceof errors.JWSSignatureVerificationFailed ||
      error instanceof errors.JOSEAlgNotAllowed ||
      error instanceof errors.JOSENotSupported ||
      error instanceof errors.JWKSNoMatchingKey
    )
      return null;
    // Transport/parser errors must not expose bearer or arbitrary response contents.
    throw new Error("Session signing keys are unavailable.");
  }
}
