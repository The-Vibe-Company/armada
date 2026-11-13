/** Intentionally readable configuration, never application/model credentials. */
export function validateReadableVariables(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid readable variables.");
  const entries = Object.entries(input);
  if (entries.length > 64) throw Error("Invalid readable variables.");
  let bytes = 0;
  for (const [key, value] of entries) {
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(key) ||
      /^(ARMADA_|BOAT_|MODAL_|ANTHROPIC_|OPENAI_|OPENCODE_|CLAUDE_|CODEX_|GH_|GITHUB_|MCP_|LD_|DYLD_)/i.test(key) ||
      /^(PATH|HOME|XDG_DATA_HOME|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_STATE_HOME|SHELL|ENV|BASH_ENV|NODE_OPTIONS|PYTHONPATH|SSL_CERT_FILE|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/.test(
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

export interface ReadableVariableBinding {
  key: string;
  variableId: string;
  version: number;
}

/** Value-free launch references, shared by templates and direct provider launches. */
export function parseReadableVariableBindings(input: unknown): ReadableVariableBinding[] {
  if (!Array.isArray(input) || input.length > 64) throw Error("Invalid variable bindings.");
  const seen = new Set<string>();
  return input.map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !["key", "variableId", "version"].includes(key)) ||
      typeof value.key !== "string" ||
      typeof value.variableId !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.variableId) ||
      !Number.isSafeInteger(value.version) ||
      value.version < 1 ||
      seen.has(value.key)
    )
      throw Error("Invalid variable bindings.");
    validateReadableVariables({ [value.key]: "" });
    seen.add(value.key);
    return { key: value.key, variableId: value.variableId.toLowerCase(), version: value.version };
  });
}
