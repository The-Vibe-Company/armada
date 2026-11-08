import { base64url, randomBytes } from "./codec.ts";

/** S256 PKCE. The verifier stays in memory or in the encrypted cookie, never in a table. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: await s256(verifier) };
}

export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return false;
  return (await s256(verifier)) === challenge;
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
