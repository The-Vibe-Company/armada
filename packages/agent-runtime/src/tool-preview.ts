/** Cut a preview without splitting a surrogate pair into a lone UTF-16 code unit. */
export function boundedPreview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = limit > 0 && /[\uD800-\uDBFF]/.test(text[limit - 1] ?? "") ? limit - 1 : limit;
  return text.slice(0, end);
}

// Match the identifier constraints enforced by /api/runtime/events.
export function toolIdentifier(value: string, fallback = "tool"): string {
  return boundedPreview(value.replaceAll("\0", ""), 256) || fallback;
}
