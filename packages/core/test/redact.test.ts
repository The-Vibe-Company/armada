import { describe, expect, test } from "bun:test";
import { KEY_PATTERNS, redactFreeText, redactor } from "../src/redact.ts";

const values = [
  { name: "OPENAI_API_KEY", value: "sk-synthetic-123456" },
  { name: "CUSTOM", value: "abcdefghi" },
];
const texts = [
  "hello sk-synthetic-123456 world abcdefghi!",
  "sk-another-synthetic-token ghp_synthetic github_pat_synthetic gho_synthetic xoxa-synthetic",
  "xoxb-synthetic xoxp-synthetic AKIA0123456789ABCDEF lin_api_synthetic armada_key_synthetic armada_launch_synthetic armada_worker_synthetic",
  "before -----BEGIN RSA PRIVATE KEY-----\nsk-inside-private\nABCDEF\n-----END RSA PRIVATE KEY----- after",
  `prefix sk-${"x".repeat(500)} suffix`,
  `before -----BEGIN PRIVATE KEY-----\n${"x".repeat(1000)}\n-----END PRIVATE KEY----- after`,
];

describe("secret masking", () => {
  test("names exact values, prefers known values over patterns, merges overlaps and skips short values", () => {
    const found: (string | null)[] = [];
    const r = redactor([...values, { name: "SHORT", value: "short" }, { name: "OVERLAP", value: "defghijk" }], {
      onRedact: (name) => found.push(name),
    });
    expect(r.text("short sk-synthetic-123456 abcdefghijk sk-unknown-key")).toBe(
      "short «secret OPENAI_API_KEY» «secret CUSTOM» «redacted»",
    );
    expect(found).toEqual(["OPENAI_API_KEY", "CUSTOM", null]);
    expect(r.text("sk-1234")).toBe("sk-1234");
    expect(r.text("sk-12345")).toBe("«redacted»");
    expect(r.text("«secret OPENAI_API_KEY» «redacted»")).toBe("«secret OPENAI_API_KEY» «redacted»");
  });

  test("built-in patterns mask complete key formats and private blocks", () => {
    for (const pattern of KEY_PATTERNS) expect(pattern).toBeInstanceOf(RegExp);
    const r = redactor(values);
    const keyLiterals = [
      "sk-another-synthetic-token",
      "ghp_synthetic",
      "github_pat_synthetic",
      "gho_synthetic",
      "xoxa-synthetic",
      "xoxb-synthetic",
      "xoxp-synthetic",
      "AKIA0123456789ABCDEF",
      "lin_api_synthetic",
      "armada_key_synthetic",
      "armada_launch_synthetic",
      "armada_worker_synthetic",
    ];
    for (const text of texts) {
      const result = r.text(text);
      for (const literal of keyLiterals) if (text.includes(literal)) expect(result).not.toContain(literal);
      expect(result).not.toContain("PRIVATE KEY");
      expect(result).not.toContain("AKIA0123456789ABCDEF");
      expect(result).not.toContain("x".repeat(100));
    }
  });

  test("every split and single-character chunks match whole-text masking, including long tokens and PEM", () => {
    const r = redactor(values);
    for (const text of texts) {
      const expected = r.text(text);
      for (let at = 0; at <= text.length; at++) {
        const stream = r.stream();
        expect(stream.write(text.slice(0, at)) + stream.write(text.slice(at)) + stream.end()).toBe(expected);
      }
      const stream = r.stream();
      expect([...text].map((char) => stream.write(char)).join("") + stream.end()).toBe(expected);
      expect(stream.end()).toBe("");
    }
  });

  test("streams normal output promptly, preserves exact-value matches across flushes, and supports custom patterns", () => {
    const r = redactor([{ name: "CUSTOM", value: "abcdefgh:more-secret" }]);
    const s = r.stream();
    expect(s.write(".".repeat(200))).toBe(".".repeat(120));
    expect(s.write(`sk-${"x".repeat(100)}abcdefgh:more-secret ${"z".repeat(100)}`) + s.end()).not.toContain(
      "more-secret",
    );
    const custom = redactor([], { patterns: [/token=\w+/] }).stream();
    expect(custom.write("token=123")).toBe("");
    expect(custom.write("45678")).toBe("");
    expect(custom.end()).toBe("«redacted»");
  });

  test("output flushes keep astral characters together for UTF-8 sinks", () => {
    const stream = redactor([]).stream();
    const chunks = [stream.write(`😀${".".repeat(79)}`), stream.end()];
    expect(chunks.map((chunk) => Buffer.from(chunk, "utf8").toString("utf8")).join("")).toBe(`😀${".".repeat(79)}`);
  });

  test("masks nested prose while leaving routing and binary payloads unchanged", () => {
    const input = {
      ticket: "abcdefghi",
      handle: "abcdefghi",
      data: "abcdefghi",
      message: "abcdefghi",
      note: "abcdefghi",
      detail: "abcdefghi",
      shippedWith: "abcdefghi",
      morePrs: "abcdefghi",
      checks: ["abcdefghi"],
      excerpts: [{ text: "abcdefghi", label: "abcdefghi" }],
      caption: "abcdefghi",
    };
    expect(redactFreeText(input, redactor(values).text)).toEqual({
      ...input,
      message: "«secret CUSTOM»",
      note: "«secret CUSTOM»",
      detail: "«secret CUSTOM»",
      shippedWith: "«secret CUSTOM»",
      morePrs: "«secret CUSTOM»",
      checks: ["«secret CUSTOM»"],
      excerpts: [{ text: "«secret CUSTOM»", label: "«secret CUSTOM»" }],
      caption: "«secret CUSTOM»",
    });
    expect(input.message).toBe("abcdefghi");
  });
});
