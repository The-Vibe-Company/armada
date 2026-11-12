import { describe, expect, test } from "bun:test";
import { mergeEvents, readLogPages } from "../src/lib/events.ts";

describe("dashboard log catch-up", () => {
  test("returns the first page before later history is available, then resumes in replay order", async () => {
    const cursors: (string | null | undefined)[] = [];
    const laterRequested = Promise.withResolvers<"later-requested">();
    const laterPage = Promise.withResolvers<unknown>();
    const logs = async (_id: string, cursor?: string | null) => {
      cursors.push(cursor);
      if (!cursor)
        return {
          events: [{ id: "one", at: 1, kind: "message", text: "partial", tools: [] }],
          cursor: "1",
          hasMore: true,
        };
      laterRequested.resolve("later-requested");
      return laterPage.promise;
    };
    const firstRead = readLogPages(logs, "sandbox", null);
    try {
      // A held second page models arbitrary upstream delay without a clock or sleep.
      expect(await Promise.race([firstRead.then(() => "first-returned"), laterRequested.promise])).toBe(
        "first-returned",
      );
      expect(cursors).toEqual([null]);
      const first = await firstRead;
      expect(first).toMatchObject({ cursor: "1", hasMore: true });
      // Historical continuation has no machine-activity prerequisite.
      const secondRead = readLogPages(logs, "sandbox", first.cursor);
      laterPage.resolve({
        events: [
          { id: "one", at: 1, kind: "message", text: "complete", tools: [] },
          { id: "two", at: 2, kind: "message", text: "two", tools: [] },
        ],
        cursor: "2",
        hasMore: false,
      });
      const second = await secondRead;
      expect(cursors).toEqual([null, "1"]);
      expect(second).toMatchObject({ cursor: "2", hasMore: false });
      expect(mergeEvents(first.events, second.events).map(({ id, text }) => ({ id, text }))).toEqual([
        { id: "one", text: "complete" },
        { id: "two", text: "two" },
      ]);
    } finally {
      laterPage.resolve({ events: [], cursor: "2", hasMore: false });
      await firstRead;
    }
  });

  test.each(["same", null, undefined, "", "   "])("rejects an unusable continuation cursor %p", async (cursor) => {
    let calls = 0;
    await expect(
      readLogPages(
        async () => {
          calls += 1;
          return { events: [], cursor, hasMore: true };
        },
        "sandbox",
        "same",
      ),
    ).rejects.toThrow("advancing cursor");
    expect(calls).toBe(1);
  });

  test("retains the last cursor when a drained page has none", async () => {
    expect(await readLogPages(async () => ({ events: [], hasMore: false }), "sandbox", "last")).toEqual({
      events: [],
      cursor: "last",
      hasMore: false,
    });
  });
});
