const PREFIXED_SECRET =
  /\b(?:armada_(?:launch|worker|key)_[A-Za-z0-9_-]+|lin_api_[A-Za-z0-9_-]+|(?:ghp|gho|ghs|github_pat|sk)_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)\b/g;

/** Mask complete known values and token prefixes, even when their matches overlap. */
export function redactSecrets(text: string, values: readonly string[] = []): string {
  // Find spans in the original text: masking a substring first would break the
  // other rule's match and expose the remainder of an overlapping credential.
  const spans: [number, number][] = [];
  for (const match of text.matchAll(PREFIXED_SECRET)) spans.push([match.index, match.index + match[0].length]);
  for (const value of new Set(values.filter(Boolean))) {
    let from = 0;
    while (from < text.length) {
      const start = text.indexOf(value, from);
      if (start < 0) break;
      spans.push([start, start + value.length]);
      from = start + 1;
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]);
    else merged.push([...span]);
  }
  let result = "",
    end = 0;
  for (const [start, next] of merged) {
    result += `${text.slice(end, start)}[redacted]`;
    end = next;
  }
  return result + text.slice(end);
}
