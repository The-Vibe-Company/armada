import { describe, expect, test } from "bun:test";
import { readLogPages } from "../src/app/api/sandboxes/[id]/events/route.ts";

describe("dashboard log catch-up", () => {
  test("follows cursors through bounded MCP pages", async () => {
    const cursors: (string | null | undefined)[] = [];
    const page = await readLogPages(
      async (_id, cursor) => {
        cursors.push(cursor);
        if (!cursor)
          return {
            events: [{ id: "one", at: 1, kind: "message", text: "one", tools: [] }],
            cursor: "1",
            hasMore: true,
          };
        return { events: [{ id: "two", at: 2, kind: "message", text: "two", tools: [] }], cursor: "2", hasMore: false };
      },
      "sandbox",
      null,
    );
    expect(cursors).toEqual([null, "1"]);
    expect(page).toMatchObject({ cursor: "2", hasMore: false });
    expect(page.events.map((event) => event.id)).toEqual(["one", "two"]);
  });

  test("stops on a repeated cursor rather than polling forever", async () => {
    let calls = 0;
    const page = await readLogPages(
      async () => {
        calls += 1;
        return { events: [], cursor: "same", hasMore: true };
      },
      "sandbox",
      "same",
    );
    expect(calls).toBe(1);
    expect(page).toEqual({ events: [], cursor: "same", hasMore: true });
  });
});
