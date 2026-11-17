import { expect, test } from "bun:test";
import { createRedactor, Journal } from "../src/index.ts";

test("a terminal snapshot cannot silently disappear at the post-redaction journal limit", () => {
  const journal = new Journal(":memory:", createRedactor(["tiny"]));
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
    expect(journal.events()[0]?.event).toMatchObject({ kind: "message", partial: false, text: "DOCKER_OK" });
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
    for (const text of ["a".repeat(262144), '"'.repeat(140000), "😀".repeat(65536)]) {
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
    expect(events).toHaveLength(6);
    for (const event of events) {
      expect(["prompt", "steer"]).toContain(event.kind);
      expect(JSON.stringify(event)).not.toContain("private_value");
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(262144);
      expect(event).toMatchObject({ promptId: "p", conversationId: "c" });
      if (event.kind === "prompt") expect(event).toMatchObject({ status: "failed", reason: "authentication_failed" });
      if (event.kind === "prompt" || event.kind === "steer") expect(event.text).toContain("[truncated]");
    }
  } finally {
    journal.close();
  }
});
