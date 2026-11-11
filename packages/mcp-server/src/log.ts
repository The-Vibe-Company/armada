import { redactKnownTokens } from "@armada/core";

const LIMIT = 600;

/**
 * Makes a failure line safe for the log: bearer tokens, Armada and OAuth tokens, JWTs, API keys and the
 * password of a connection string are masked, and the line is cut. Messages from the driver or Postgres
 * can echo a parameter, so nothing is logged raw.
 */
export function redactForLog(text: string): string {
  const masked = redactKnownTokens(text)
    .replace(/\b(bearer\s+)\S+/gi, "$1***")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@/gi, (match) => `${match.slice(0, match.indexOf("://") + 3)}***@`)
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "***")
    .replace(/\barmada_[a-z]+_[\w-]{8,}/gi, "***")
    .replace(/\b(?:sk|sb)[-_][\w-]{8,}/gi, "***");
  return masked.length > LIMIT ? `${masked.slice(0, LIMIT)}...` : masked;
}
