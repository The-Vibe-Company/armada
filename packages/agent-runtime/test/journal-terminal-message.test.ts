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
