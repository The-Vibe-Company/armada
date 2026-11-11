import { SKILLPACK_TOKEN_PATTERN } from "./skillpack-token.ts";

/** GitHub tokens, whether or not they were explicitly supplied as launch secrets. */
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
const SKILLPACK_TOKEN = new RegExp(SKILLPACK_TOKEN_PATTERN, "g");

/** Masks recognized token formats without requiring a credential store or server runtime. */
export function redactKnownTokens(text: string): string {
  return text
    .replace(GITHUB_TOKEN, "***")
    .replace(/\barmada_gw_[A-Za-z0-9_-]{32,}/g, "***")
    .replace(SKILLPACK_TOKEN, "***");
}
