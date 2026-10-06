// Pure masking shared by terminals and the server. Raw values never appear in
// notices; the caller may report the exact secret's name or a pattern match.
export const KEY_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|$)/g,
  /(?:sk-|ghp_|github_pat_|gho_|xox[abp]-|lin_api_|armada_key_|armada_launch_|armada_worker_)[A-Za-z0-9_-]+/g,
  /AKIA[0-9A-Z]{16}/g,
];
const KEY_START =
  /(?:sk-|ghp_|github_pat_|gho_|xox[abp]-|lin_api_|armada_key_|armada_launch_|armada_worker_)[A-Za-z0-9_-]+/g;
const PEM_START = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g;
const PEM_END = /-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
type Mode = "key" | "pem" | null;
interface Span {
  start: number;
  end: number;
  name: string | null;
  continued?: boolean;
}

export function redactor(
  values: readonly { name: string; value: string }[],
  {
    patterns = KEY_PATTERNS,
    onRedact,
  }: {
    patterns?: readonly RegExp[];
    onRedact?: (name: string | null) => void;
  } = {},
) {
  const secrets = values.filter((v) => v.value.length >= 8).sort((a, b) => b.value.length - a.value.length);
  const regexes = patterns.map((p) => new RegExp(p.source, `${p.flags.replace(/[gy]/g, "")}g`));
  const scan = (s: string): Span[] => {
    const spans: Span[] = [];
    for (const { name, value } of secrets) {
      let from = 0;
      while (from <= s.length - value.length) {
        const start = s.indexOf(value, from);
        if (start < 0) break;
        spans.push({ start, end: start + value.length, name });
        from = start + 1;
      }
    }
    for (const pattern of regexes) {
      pattern.lastIndex = 0;
      for (const match of s.matchAll(pattern)) {
        if (match[0].length >= 8) spans.push({ start: match.index, end: match.index + match[0].length, name: null });
      }
    }
    return spans;
  };
  // Overlapping matches are one masked interval. A known value gives it a
  // useful name even when a key pattern covers a longer surrounding token.
  const merge = (spans: Span[]) => {
    const merged: Span[] = [];
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    for (const span of spans) {
      const prev = merged.at(-1);
      if (prev && span.start < prev.end) {
        prev.end = Math.max(prev.end, span.end);
        prev.name ??= span.name;
        prev.continued ||= span.continued;
      } else merged.push({ ...span });
    }
    return merged;
  };
  const render = (s: string, spans: Span[], cut: number) => {
    let out = "";
    let pos = 0;
    let hidden = 0;
    for (const span of merge(spans)) {
      if (span.start >= cut) break;
      out += s.slice(pos, span.start);
      if (!span.continued) {
        out += span.name === null ? "«redacted»" : `«secret ${span.name}»`;
        onRedact?.(span.name);
      }
      pos = Math.min(cut, span.end);
      hidden = Math.max(hidden, span.end - cut);
    }
    return { out: out + s.slice(pos, cut), hidden };
  };
  const text = (s: string) => render(s, scan(s), s.length).out;
  return {
    text,
    stream() {
      // Built-ins have recognizable open tokens. Keep an exact-value tail
      // and carry masking across arbitrarily long key/PEM blocks without
      // buffering those blocks. A custom, unbounded regex has no knowable
      // lookahead, so custom-pattern streams buffer until end instead.
      const tail = Math.max(80, ...secrets.map((v) => v.value.length - 1));
      let buffer = "";
      let hidden = 0;
      let mode: Mode = null;
      let ended = false;
      const flush = (final: boolean) => {
        if (patterns !== KEY_PATTERNS) {
          if (!final) return "";
          const out = text(buffer);
          buffer = "";
          return out;
        }
        let cut = final ? buffer.length : Math.max(0, buffer.length - tail);
        // A UTF-8 decoder can deliver astral characters as UTF-16 pairs.
        // Keep the pair together when the string is written back to UTF-8.
        if (!final && /[\uD800-\uDBFF]/.test(buffer[cut - 1] ?? "") && /[\uDC00-\uDFFF]/.test(buffer[cut] ?? "")) cut--;
        if (!cut) return "";
        const spans = scan(buffer);
        const tokens: { start: number; end: number; mode: Mode; closed?: boolean }[] = [];
        if (hidden) spans.push({ start: 0, end: hidden, name: null, continued: true });
        if (mode === "key") {
          const end = /^[A-Za-z0-9_-]*/.exec(buffer)?.[0].length ?? 0;
          if (end) {
            spans.push({ start: 0, end, name: null, continued: true });
            tokens.push({ start: 0, end, mode: "key", closed: end < buffer.length });
          }
        } else if (mode === "pem") {
          const endMatch = PEM_END.exec(buffer);
          const end = endMatch ? endMatch.index + endMatch[0].length : buffer.length;
          spans.push({ start: 0, end, name: null, continued: true });
          tokens.push({ start: 0, end, mode: "pem", closed: !!endMatch });
        }
        KEY_START.lastIndex = 0;
        for (const m of buffer.matchAll(KEY_START)) {
          if (m[0].length >= 8)
            tokens.push({
              start: m.index,
              end: m.index + m[0].length,
              mode: "key",
              closed: m.index + m[0].length < buffer.length,
            });
        }
        PEM_START.lastIndex = 0;
        for (const m of buffer.matchAll(PEM_START)) {
          const endMatch = PEM_END.exec(buffer.slice(m.index + m[0].length));
          const end = endMatch ? m.index + m[0].length + endMatch.index + endMatch[0].length : buffer.length;
          tokens.push({ start: m.index, end, mode: "pem", closed: !!endMatch });
        }
        // cut === end still carries an unterminated token into the next
        // chunk. A delimiter in the retained tail closes it on the next scan.
        mode =
          tokens
            .sort((a, b) => a.start - b.start)
            .find((t) => t.start < cut && (t.end > cut || (t.end === cut && !t.closed)))?.mode ?? null;
        const result = render(buffer, spans, cut);
        hidden = result.hidden;
        buffer = buffer.slice(cut);
        return result.out;
      };
      return {
        write(chunk: string) {
          if (ended) throw new Error("redaction stream has ended");
          buffer += chunk;
          return flush(false);
        },
        end() {
          if (ended) return "";
          ended = true;
          return flush(true);
        },
      };
    },
  };
}

const FREE_TEXT = new Set([
  "message",
  "summary",
  "body",
  "plan",
  "question",
  "options",
  "choices",
  "what",
  "checks",
  "details",
  "excerpts",
  "caption",
  "reason",
  "decision",
  "resolution",
  "throughHold",
  "progress",
  "text",
  "title",
  "content",
]);
/** Mask prose without changing ticket ids, runtime handles, SHAs or other routing fields. */
export function redactFreeText<T>(input: T, text: (s: string) => string): T {
  const walk = (v: unknown, prose = false): unknown => {
    if (typeof v === "string") return prose ? text(v) : v;
    if (Array.isArray(v)) return v.map((item) => walk(item, prose));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([key, value]) => [key, walk(value, prose || FREE_TEXT.has(key))]),
      );
    return v;
  };
  return walk(input) as T;
}
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
