import { SKILLPACK_TOKEN_PATTERN } from "./skillpack-token.ts";

/** GitHub tokens, whether or not they were explicitly supplied as launch secrets. */
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
const SKILLPACK_TOKEN = new RegExp(SKILLPACK_TOKEN_PATTERN, "g");

/** Masks the union of recognized tokens and exact secrets in the original text. */
export function redactKnownTokens(text: string, secrets: readonly string[] = []): string {
  const spans: [number, number][] = [];
  for (const pattern of [GITHUB_TOKEN, /\barmada_gw_[A-Za-z0-9_-]{32,}/g, SKILLPACK_TOKEN]) {
    for (const match of text.matchAll(pattern)) spans.push([match.index, match.index + match[0].length]);
  }
  for (const secret of secrets) {
    if (!secret) continue;
    let start = text.indexOf(secret);
    while (start !== -1) {
      spans.push([start, start + secret.length]);
      start = text.indexOf(secret, start + 1);
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span[0] < previous[1]) previous[1] = Math.max(previous[1], span[1]);
    else merged.push([...span]);
  }
  let out = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    out += text.slice(cursor, start) + "***";
    cursor = end;
  }
  return out + text.slice(cursor);
}
