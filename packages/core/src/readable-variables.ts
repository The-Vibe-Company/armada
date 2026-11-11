/** Intentionally readable configuration, never application/model credentials. */
export function validateReadableVariables(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid readable variables.");
  const entries = Object.entries(input);
  if (entries.length > 64) throw Error("Invalid readable variables.");
  let bytes = 0;
  for (const [key, value] of entries) {
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(key) ||
      /^(ARMADA_|BOAT_|MODAL_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|GH_|GITHUB_|MCP_|LD_|DYLD_)/i.test(key) ||
      /^(PATH|HOME|SHELL|ENV|BASH_ENV|NODE_OPTIONS|PYTHONPATH|SSL_CERT_FILE|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/.test(
        key,
      ) ||
      typeof value !== "string" ||
      value.includes("\0") ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
    )
      throw Error("Invalid readable variables.");
    const size = new TextEncoder().encode(value).length;
    if (size > 8192) throw Error("Invalid readable variables.");
    bytes += size;
  }
  if (bytes > 65536) throw Error("Invalid readable variables.");
  return Object.fromEntries(entries) as Record<string, string>;
}
