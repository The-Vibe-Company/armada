import { expect, test } from "bun:test";
import { createRedactor, Journal } from "../src/index.ts";

test("a terminal snapshot cannot silently disappear at the post-redaction journal limit", () => {
  const journal = new Journal(":memory:", createRedactor(["tiny", "snapshot"]));
  try {
    const message = {
      id: "final",
      at: 1,
      kind: "message" as const,
      partial: false,
      textMode: "snapshot" as const,
      messageId: "answer",
      tools: [],
      text: "DOCKER_OK",
    };
    journal.append(message);
    journal.sanitize();
    expect(journal.events()[0]?.event).toMatchObject({
      kind: "message",
      partial: false,
      textMode: "snapshot",
      text: "DOCKER_OK",
    });
    // Raw JSON fits; redaction expands 4-character tokens to the longer marker.
    expect(() => journal.append({ ...message, id: "too-large", text: "tiny ".repeat(25000) })).toThrow(
      "invalid_harness_protocol",
    );
    const marker = journal.events()[1]?.event;
    expect(marker).toMatchObject({
      kind: "other",
      type: "event_truncated",
      data: { originalKind: "message", terminal: true },
    });
    if (marker?.kind !== "other") throw Error("missing truncation receipt");
    expect((marker.data as { bytes: number }).bytes).toBeGreaterThan(262144);
  } finally {
    journal.close();
  }
});

test("large prompt and steer previews preserve control metadata after escaping and redaction", () => {
  const journal = new Journal(":memory:", createRedactor(["private_value"]));
  try {
    // The last case puts a surrogate pair across the preview boundary.
    for (const text of ["a".repeat(262144), '"'.repeat(140000), "😀".repeat(65536), `a${"😀".repeat(65536)}`]) {
      const prompt = {
        promptId: "p",
        conversationId: "c",
        status: "queued" as const,
        request: { sandboxId: "logical", harness: "claude" as const, text: `private_value ${text}` },
      };
      journal.transition(prompt, "failed", "authentication_failed");
      journal.append({ id: "s", at: 1, kind: "steer", promptId: "p", conversationId: "c", text: prompt.request.text });
    }
    const events = journal.events().map((row) => row.event);
    expect(events).toHaveLength(8);
    for (const event of events) {
      expect(["prompt", "steer"]).toContain(event.kind);
      expect(JSON.stringify(event)).not.toContain("private_value");
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(262144);
      expect(event).toMatchObject({ promptId: "p", conversationId: "c" });
      if (event.kind === "prompt") expect(event).toMatchObject({ status: "failed", reason: "authentication_failed" });
      if (event.kind === "prompt" || event.kind === "steer") {
        expect(event.text).toContain("[truncated]");
        // A preview must never contain an unpaired surrogate from a split pair.
        expect(event.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      }
    }
  } finally {
    journal.close();
  }
});

test("short application values stay out of streamed message text while snapshots keep their type", () => {
  const journal = new Journal(":memory:", createRedactor([]));
  try {
    const message = {
      id: "event",
      at: 1,
      kind: "message" as const,
      messageId: "answer",
      tools: [],
    };
    journal.append({ ...message, textMode: "delta", partial: true, text: "before registration" });
    journal.registerApplicationSecrets(["delta", "message", "42"]);
    for (const text of ["prefix-de", "lta-suffix"])
      journal.append({ ...message, textMode: "delta", partial: true, text });
    journal.append({
      ...message,
      textMode: "snapshot",
      partial: false,
      text: "prefix-delta-suffix",
      tools: [
        {
          id: "tool",
          name: "read-message",
          server: "delta-proxy",
          input: { "message-key": "prefix-delta", count: 42 },
          result: { output: ["prefix-message"], isError: false },
        },
      ],
    });
    journal.sanitize();
    const events = journal.events().map(({ event }) => event);
    expect(events[0]).toMatchObject({ text: "before registration", textMode: "delta" });
    expect(events.slice(1, 3)).toEqual(
      Array.from({ length: 2 }, () => ({ ...message, textMode: "delta", partial: true, text: "" })),
    );
    expect(events[3]).toMatchObject({
      kind: "message",
      textMode: "snapshot",
      messageId: "answer",
      text: "prefix-[REDACTED]-suffix",
      tools: [
        {
          id: "tool",
          name: "read-[REDACTED]",
          server: "[REDACTED]-proxy",
          input: { "[REDACTED]-key": "prefix-[REDACTED]", count: "[REDACTED]" },
          result: { output: ["prefix-[REDACTED]"], isError: false },
        },
      ],
    });
  } finally {
    journal.close();
  }
});

test("short application redaction keeps expanded command output within its capture limit", () => {
  const journal = new Journal(":memory:", (text) => text);
  try {
    journal.registerApplicationSecrets(["x"]);
    expect(journal.redactCommandOutput({ text: "x".repeat(16), truncated: false }, 16)).toEqual({
      text: "[REDACTED]",
      truncated: true,
    });
  } finally {
    journal.close();
  }
});
